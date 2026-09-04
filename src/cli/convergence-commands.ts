import { Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { pullCatalog, pushCatalog, saveCatalog, syncCatalog } from "../lib/convergence.ts";
import { renderConvergenceEvent } from "./render.ts";
import { dryRunFlag, forceFlag, pullFlag, withRepo } from "./shared.ts";

export const syncCommand = Command.make("sync", { dryRun: dryRunFlag, force: forceFlag, pull: pullFlag }, ({ dryRun, force }) =>
  withRepo(syncCatalog({ dryRun, force, onEvent: renderConvergenceEvent })),
).pipe(Command.withDescription("Save, pull, reconcile, and restore live vendor drift"));

export const pullCommand = Command.make("pull", { dryRun: dryRunFlag, force: forceFlag }, ({ dryRun, force }) =>
  withRepo(pullCatalog({ dryRun, force, onEvent: renderConvergenceEvent })),
).pipe(Command.withDescription("Fast-forward the catalog from its upstream (replaying diverged local commits), align local state, and sync"));

export const pushCommand = Command.make("push", { dryRun: dryRunFlag }, ({ dryRun }) => withRepo(pushCatalog({ dryRun, onEvent: renderConvergenceEvent }))).pipe(
  Command.withDescription("Push the clean, verified catalog branch to its configured upstream"),
);

export const saveCommand = Command.make(
  "save",
  {
    message: Flag.string("message").pipe(Flag.withAlias("m"), Flag.optional, Flag.withDescription("Git commit message (default: Update skills catalog)")),
  },
  ({ message }) => withRepo(saveCatalog({ message: Option.getOrUndefined(message), onEvent: renderConvergenceEvent })),
).pipe(Command.withDescription("Verify and commit catalog-managed paths in the skills host"));
