import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { removeFollower, saveFollower, syncFleet } from "../lib/fleet.ts";
import { Paths } from "../lib/paths.ts";
import { c, pad, renderConvergenceEvent } from "./render.ts";
import { dryRunFlag, withRepo } from "./shared.ts";

const fleetList = Effect.gen(function* () {
  const paths = yield* Paths;
  const fleet = yield* paths.readFleet();
  if (fleet.length === 0) {
    console.log(c.dim("no followers registered; add one with `slinky fleet add <name> <ssh-target>`"));
    return;
  }
  const width = Math.max(...fleet.map((member) => member.name.length)) + 2;
  for (const member of fleet) {
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
      const saved = yield* saveFollower({ name, ssh, command: Option.getOrUndefined(command) });
      console.log(`${saved.replaced ? "updated" : "added"} follower ${c.bold(saved.member.name)} -> ${saved.member.ssh}`);
    }),
).pipe(Command.withDescription("Register (or update) a follower this machine syncs over ssh"));

const fleetRemoveCommand = Command.make("remove", { name: Argument.string("name") }, ({ name }) =>
  Effect.gen(function* () {
    yield* removeFollower(name);
    console.log(`removed follower ${name}`);
  }),
).pipe(Command.withDescription("Stop syncing a follower"));

const fleetSyncCommand = Command.make(
  "sync",
  {
    dryRun: dryRunFlag,
    only: Argument.string("follower").pipe(Argument.variadic({ min: 0 })),
  },
  ({ dryRun, only }) =>
    withRepo(
      Effect.gen(function* () {
        console.log(c.bold("LEADER"));
        yield* syncFleet({ dryRun, only, onEvent: renderConvergenceEvent });
      }),
    ),
).pipe(Command.withDescription("Sync and push this machine, then have every follower pull, reconcile, and restore over ssh"));

export const fleetCommand = Command.make("fleet", {}, () => fleetList).pipe(
  Command.withDescription("List the followers this machine leads, or register, remove, and sync them"),
  Command.withSubcommands([fleetAddCommand, fleetRemoveCommand, fleetSyncCommand]),
);
