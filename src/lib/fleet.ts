import { spawn } from "node:child_process";
import { Effect, Schema } from "effect";
import { errorDetail, FleetMember, OperationFailed } from "../domain/model.ts";
import { pushCatalog, emitConvergenceEvent, syncCatalog } from "./convergence.ts";
import type { ConvergenceEventSink } from "./convergence.ts";
import { compareWithUpstream, requireUpstream } from "./git.ts";
import { HostRepo, Paths } from "./paths.ts";

export interface FleetSyncOptions {
  readonly dryRun?: boolean;
  readonly onEvent?: ConvergenceEventSink;
}

export interface FleetRunOptions extends FleetSyncOptions {
  /** Follower names to sync; empty or absent means the whole fleet. */
  readonly only?: ReadonlyArray<string>;
}

export interface FollowerResult {
  readonly member: FleetMember;
  /** Exit status of ssh (the remote command's status when the connection succeeded); null if ssh never ran. */
  readonly status: number | null;
  /** stdout and stderr interleaved in arrival order. */
  readonly output: string;
}

export interface FollowerFields {
  readonly name: string;
  readonly ssh: string;
  /** Blank or absent means `slinky` on the remote PATH. */
  readonly command?: string | undefined;
}

const bail = (message: string) => Effect.fail(new OperationFailed({ message }));

const decodeMember = Schema.decodeUnknownSync(FleetMember);

/** Validate typed-in follower fields; a blank command falls back to `slinky`. */
export const followerFromFields = (fields: FollowerFields) =>
  Effect.try({
    try: () => {
      const name = fields.name.trim();
      const ssh = fields.ssh.trim();
      const command = fields.command?.trim();
      return decodeMember(command ? { name, ssh, command } : { name, ssh });
    },
    catch: (error) => new OperationFailed({ message: `invalid follower: ${errorDetail(error)}` }),
  });

/**
 * Add a follower, or replace the one named `previous` (a rename when the names
 * differ). Refuses to overwrite a different follower that already has the name.
 */
export const saveFollower = Effect.fn("Fleet.saveFollower")(function* (fields: FollowerFields, previous?: string) {
  const paths = yield* Paths;
  const member = yield* followerFromFields(fields);
  const current = yield* paths.readFleet();
  const taken = current.some((candidate) => candidate.name === member.name && candidate.name !== previous);
  if (taken && previous !== undefined) return yield* bail(`another follower is already named ${member.name}`);
  const replacing = previous ?? member.name;
  const exists = current.some((candidate) => candidate.name === replacing);
  const fleet = yield* paths.updateFleet((latest) =>
    exists ? latest.map((candidate) => (candidate.name === replacing ? member : candidate)) : [...latest.filter((candidate) => candidate.name !== member.name), member],
  );
  return { member, fleet, replaced: exists };
});

export const removeFollower = Effect.fn("Fleet.removeFollower")(function* (name: string) {
  const paths = yield* Paths;
  const current = yield* paths.readFleet();
  if (!current.some((member) => member.name === name)) return yield* bail(`no follower named ${name}`);
  return yield* paths.updateFleet((latest) => latest.filter((member) => member.name !== name));
});

/** Pick members by name, keeping registration order; no names means the whole fleet. */
export function selectFleetMembers(fleet: ReadonlyArray<FleetMember>, names: ReadonlyArray<string>): ReadonlyArray<FleetMember> | { readonly unknown: ReadonlyArray<string> } {
  if (names.length === 0) return fleet;
  const known = new Set(fleet.map((member) => member.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) return { unknown };
  const wanted = new Set(names);
  return fleet.filter((member) => wanted.has(member.name));
}

/** The ssh argv that runs one slinky subcommand on a follower. */
function remoteArgv(member: FleetMember, subcommand: string): ReadonlyArray<string> {
  // BatchMode: a password or host-key prompt would hang a parallel run instead of failing it.
  return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", member.ssh, `${member.command ?? "slinky"} ${subcommand}`];
}

/**
 * The ssh invocation that makes one follower take the leader's catalog. The
 * remote command is a shell string by nature of ssh; the member's command is
 * the user's own configuration, so it is passed through verbatim.
 */
export function followerArgv(member: FleetMember, dryRun: boolean): ReadonlyArray<string> {
  return remoteArgv(member, `sync --follower${dryRun ? " --dry-run" : ""}`);
}

const runRemote = (member: FleetMember, argv: ReadonlyArray<string>) =>
  Effect.callback<FollowerResult>((resume) => {
    const [command = "ssh", ...args] = argv;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.on("error", (error) => resume(Effect.succeed({ member, status: null, output: `${output}could not run ssh: ${error.message}\n` })));
    child.on("close", (status) => resume(Effect.succeed({ member, status, output })));
    return Effect.sync(() => child.kill());
  });

/** Run the follower step on every member at once; one unreachable host never stops the others. */
export const syncFollowers = Effect.fn("Fleet.syncFollowers")(function* (members: ReadonlyArray<FleetMember>, dryRun: boolean, onResult?: (result: FollowerResult) => void) {
  return yield* Effect.forEach(members, (member) => runRemote(member, followerArgv(member, dryRun)).pipe(Effect.tap((result) => Effect.sync(() => onResult?.(result)))), {
    concurrency: "unbounded",
  });
});

/** Check that a follower is reachable and its slinky runs, without changing anything there. */
export const checkFollower = (member: FleetMember) => runRemote(member, remoteArgv(member, "version"));

/**
 * Converge the leader and publish it: full sync (save, pull, reconcile,
 * restore), then push whatever the upstream does not have yet, so followers
 * pulling from that upstream see exactly this catalog.
 */
export const syncLeader = Effect.fn("Fleet.syncLeader")(function* (options: FleetSyncOptions) {
  const { repo } = yield* HostRepo;
  const { upstream } = yield* requireUpstream(repo).pipe(
    Effect.mapError((error) => new OperationFailed({ message: `fleet sync publishes through the leader's upstream: ${error.message}` })),
  );
  yield* syncCatalog({ dryRun: options.dryRun ?? false, onEvent: options.onEvent });
  const say = (text: string) => emitConvergenceEvent(options.onEvent, { type: "message", message: text });
  yield* emitConvergenceEvent(options.onEvent, { type: "section", title: "publish", leadingBlank: true });
  const comparison = yield* compareWithUpstream(repo);
  if (comparison.kind !== "compared") return yield* bail(`could not compare the leader with ${upstream} before publishing`);
  if (comparison.behind > 0) return yield* bail(`leader is ${comparison.behind} commit(s) behind ${upstream} after syncing; run the fleet sync again`);
  if (options.dryRun) {
    yield* say(comparison.ahead > 0 ? `would push ${comparison.ahead} commit(s) to ${upstream}` : `would push anything the save above commits to ${upstream}`);
    return;
  }
  if (comparison.ahead === 0) {
    yield* say(`${upstream} already has the leader's catalog`);
    return;
  }
  yield* pushCatalog({ onEvent: options.onEvent });
});

/**
 * The whole fleet sync: converge and publish the leader, then have every
 * selected follower pull, reporting each one as it finishes. Reads the
 * followers from the config file at call time.
 */
export const syncFleet = Effect.fn("Fleet.syncFleet")(function* (options: FleetRunOptions = {}) {
  const paths = yield* Paths;
  const fleet = yield* paths.readFleet();
  if (fleet.length === 0) return yield* bail("no followers registered; add one with `slinky fleet add <name> <ssh-target>`");
  const selected = selectFleetMembers(fleet, options.only ?? []);
  if ("unknown" in selected) return yield* bail(`unknown follower(s): ${selected.unknown.join(", ")}`);
  const dryRun = options.dryRun ?? false;
  yield* syncLeader(options);
  yield* emitConvergenceEvent(options.onEvent, { type: "section", title: "followers", leadingBlank: true });
  for (const member of selected) yield* emitConvergenceEvent(options.onEvent, { type: "message", message: `$ ${followerArgv(member, dryRun).join(" ")}`, tone: "dim" });
  const results = yield* syncFollowers(selected, dryRun, (result) => {
    try {
      options.onEvent?.({ type: "follower", name: result.member.name, target: result.member.ssh, status: result.status, output: result.output });
    } catch {
      // Presentation failures cannot participate in the fleet run.
    }
  });
  const failed = results.filter((result) => result.status !== 0).map((result) => result.member.name);
  if (failed.length > 0) return yield* bail(`${failed.length} of ${results.length} follower(s) failed: ${failed.join(", ")}`);
  yield* emitConvergenceEvent(options.onEvent, { type: "message", message: `${results.length} follower(s) ${dryRun ? "previewed" : "synced"}`, tone: "success" });
  return results;
});
