import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { errorDetail, FleetMember, OperationFailed } from "../domain/model.ts";
import { followerArgv, selectFleetMembers, syncFollowers, syncLeader } from "../lib/fleet.ts";
import type { FollowerResult } from "../lib/fleet.ts";
import { Paths } from "../lib/paths.ts";
import { c, pad, renderConvergenceEvent } from "./render.ts";
import { bail, dryRunFlag, withRepo } from "./shared.ts";

const decodeMember = Schema.decodeUnknownSync(FleetMember);

const fleetList = Effect.gen(function* () {
  const paths = yield* Paths;
  if (paths.fleet.length === 0) {
    console.log(c.dim("no followers registered; add one with `slinky fleet add <name> <ssh-target>`"));
    return;
  }
  const width = Math.max(...paths.fleet.map((member) => member.name.length)) + 2;
  for (const member of paths.fleet) {
    const command = member.command === undefined ? "" : c.dim(`  (runs ${member.command})`);
    console.log(`${pad(member.name, width)}${member.ssh}${command}`);
  }
});

const fleetAddCommand = Command.make(
  "add",
  {
    name: Argument.string("name"),
    ssh: Argument.string("ssh-target"),
    command: Flag.string("command").pipe(
      Flag.optional,
      Flag.withDescription('Remote command that runs slinky when it is not on the non-interactive ssh PATH (e.g. "~/.bun/bin/slinky")'),
    ),
  },
  ({ name, ssh, command }) =>
    Effect.gen(function* () {
      const paths = yield* Paths;
      const fields = Option.isSome(command) ? { name, ssh, command: command.value } : { name, ssh };
      const member = yield* Effect.try({
        try: () => decodeMember(fields),
        catch: (error) => new OperationFailed({ message: `invalid follower: ${errorDetail(error)}` }),
      });
      const existing = paths.fleet.some((current) => current.name === name);
      yield* paths.saveFleet(existing ? paths.fleet.map((current) => (current.name === name ? member : current)) : [...paths.fleet, member]);
      console.log(`${existing ? "updated" : "added"} follower ${c.bold(name)} -> ${ssh}`);
    }),
).pipe(Command.withDescription("Register (or update) a follower this machine syncs over ssh"));

const fleetRemoveCommand = Command.make("remove", { name: Argument.string("name") }, ({ name }) =>
  Effect.gen(function* () {
    const paths = yield* Paths;
    if (!paths.fleet.some((member) => member.name === name)) return yield* bail(`no follower named ${name}`);
    yield* paths.saveFleet(paths.fleet.filter((member) => member.name !== name));
    console.log(`removed follower ${name}`);
  }),
).pipe(Command.withDescription("Stop syncing a follower"));

function renderFollower(result: FollowerResult, width: number): void {
  const label = result.status === 0 ? c.green("ok") : c.red(result.status === null ? "failed (ssh did not run)" : `failed (exit ${result.status})`);
  console.log(`\n${c.bold(pad(result.member.name, width))}${label}  ${c.dim(result.member.ssh)}`);
  for (const line of result.output.trimEnd().split("\n")) if (line) console.log(`  ${line}`);
}

const fleetSyncCommand = Command.make(
  "sync",
  {
    dryRun: dryRunFlag,
    only: Argument.string("follower").pipe(Argument.variadic({ min: 0 })),
  },
  ({ dryRun, only }) =>
    withRepo(
      Effect.gen(function* () {
        const paths = yield* Paths;
        if (paths.fleet.length === 0) return yield* bail("no followers registered; add one with `slinky fleet add <name> <ssh-target>`");
        const selected = selectFleetMembers(paths.fleet, only);
        if ("unknown" in selected) return yield* bail(`unknown follower(s): ${selected.unknown.join(", ")}`);

        console.log(c.bold("LEADER"));
        yield* syncLeader({ dryRun, onEvent: renderConvergenceEvent });

        console.log(`\n${c.bold("FOLLOWERS")}`);
        for (const member of selected) console.log(c.dim(`$ ${followerArgv(member, dryRun).join(" ")}`));
        const results = yield* syncFollowers(selected, dryRun);
        const width = Math.max(...selected.map((member) => member.name.length)) + 2;
        for (const result of results) renderFollower(result, width);

        const failed = results.filter((result) => result.status !== 0).map((result) => result.member.name);
        console.log("");
        if (failed.length > 0) return yield* bail(`${failed.length} of ${results.length} follower(s) failed: ${failed.join(", ")}`);
        console.log(c.green(`${results.length} follower(s) ${dryRun ? "previewed" : "synced"}`));
      }),
    ),
).pipe(Command.withDescription("Sync and push this machine, then have every follower pull, reconcile, and restore over ssh"));

export const fleetCommand = Command.make("fleet", {}, () => fleetList).pipe(
  Command.withDescription("List the followers this machine leads, or register, remove, and sync them"),
  Command.withSubcommands([fleetAddCommand, fleetRemoveCommand, fleetSyncCommand]),
);
