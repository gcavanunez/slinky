import { spawn } from "node:child_process";
import { Effect } from "effect";
import { OperationFailed } from "../domain/model.ts";
import type { FleetMember } from "../domain/model.ts";
import { pushCatalog, emitConvergenceEvent, syncCatalog } from "./convergence.ts";
import type { ConvergenceEventSink } from "./convergence.ts";
import { compareWithUpstream, requireUpstream } from "./git.ts";
import { HostRepo } from "./paths.ts";

export interface FleetSyncOptions {
  readonly dryRun?: boolean;
  readonly onEvent?: ConvergenceEventSink;
}

export interface FollowerResult {
  readonly member: FleetMember;
  /** Exit status of ssh (the remote command's status when the connection succeeded); null if ssh never ran. */
  readonly status: number | null;
  /** stdout and stderr interleaved in arrival order. */
  readonly output: string;
}

const bail = (message: string) => Effect.fail(new OperationFailed({ message }));

/** Pick members by name, keeping registration order; no names means the whole fleet. */
export function selectFleetMembers(fleet: ReadonlyArray<FleetMember>, names: ReadonlyArray<string>): ReadonlyArray<FleetMember> | { readonly unknown: ReadonlyArray<string> } {
  if (names.length === 0) return fleet;
  const known = new Set(fleet.map((member) => member.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) return { unknown };
  const wanted = new Set(names);
  return fleet.filter((member) => wanted.has(member.name));
}

/**
 * The ssh invocation that makes one follower take the leader's catalog. The
 * remote command is a shell string by nature of ssh; the member's command is
 * the user's own configuration, so it is passed through verbatim.
 */
export function followerArgv(member: FleetMember, dryRun: boolean): ReadonlyArray<string> {
  const remote = `${member.command ?? "slinky"} sync --follower${dryRun ? " --dry-run" : ""}`;
  // BatchMode: a password or host-key prompt would hang a parallel run instead of failing it.
  return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", member.ssh, remote];
}

const runFollower = (member: FleetMember, dryRun: boolean) =>
  Effect.callback<FollowerResult>((resume) => {
    const [command = "ssh", ...args] = followerArgv(member, dryRun);
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.on("error", (error) => resume(Effect.succeed({ member, status: null, output: `${output}could not run ssh: ${error.message}\n` })));
    child.on("close", (status) => resume(Effect.succeed({ member, status, output })));
    return Effect.sync(() => child.kill());
  });

/** Run the follower step on every member at once; one unreachable host never stops the others. */
export const syncFollowers = Effect.fn("Fleet.syncFollowers")(function* (members: ReadonlyArray<FleetMember>, dryRun: boolean) {
  return yield* Effect.forEach(members, (member) => runFollower(member, dryRun), { concurrency: "unbounded" });
});

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
