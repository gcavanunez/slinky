import { Effect, Option } from "effect";
import { Argument, Flag } from "effect/unstable/cli";
import { errorDetail, OperationFailed } from "../domain/model.ts";
import type { Manifest, State } from "../domain/model.ts";
import { ExternalToolError } from "../domain/model.ts";
import { pagePatch, unifiedDiff } from "../lib/diff.ts";
import type { DiffPager } from "../lib/diff.ts";
import { layerRepo } from "../lib/layers.ts";
import { ManifestStore } from "../lib/manifest.ts";
import { Paths } from "../lib/paths.ts";
import type { HostRepo } from "../lib/paths.ts";
import { reconcileCatalog } from "../lib/reconcile.ts";
import type { GitHub } from "../lib/update.ts";
import { c } from "./render.ts";

/** Expected usage/domain failure surfaced as `error: <message>` with exit 1. */
export const bail = (message: string) => Effect.fail(new OperationFailed({ message }));

type RepoServices = ManifestStore | GitHub | HostRepo;

/** Run a repo-scoped effect; repo discovery failures become typed errors. */
export const withRepo = <A, E>(effect: Effect.Effect<A, E, RepoServices | Paths>) => Effect.provide(effect, layerRepo);

/** Load the manifest and its aligned state along with the store handle. */
export const loadHostState = Effect.gen(function* () {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  return { store, manifest, state };
});

interface SyncOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export const runSyncCmd = Effect.fn("Cli.runSync")(function* (manifest: Manifest, state: State, options: SyncOptions) {
  const { plan, applied } = yield* reconcileCatalog(manifest, state, options);
  for (const w of plan.warnings) console.log(c.yellow(`warn: ${w}`));
  if (options.dryRun) {
    if (plan.actions.length === 0) console.log("nothing to do");
    for (const a of plan.actions) console.log(`would ${a.type} ${a.skill}`);
    return;
  }
  if (!applied) return;
  for (const d of applied.done) console.log(`  ${d}`);
  for (const s of applied.skipped) console.log(c.yellow(`  skipped: ${s}`));
  if (applied.done.length === 0 && applied.skipped.length === 0) console.log("in sync; nothing to do");
});

export const renderPatch = Effect.fn("Cli.renderPatch")(function* (baseline: string, live: string) {
  return yield* Effect.try({
    try: () => unifiedDiff(baseline, live),
    catch: (error) => new ExternalToolError({ tool: "diff", message: errorDetail(error) }),
  });
});

export const openPager = Effect.fn("Cli.openPager")(function* (patch: string, pager: DiffPager) {
  yield* Effect.try({
    try: () => pagePatch(patch, pager),
    catch: (error) => new ExternalToolError({ tool: pager, message: errorDetail(error) }),
  });
});

interface PagerChoice {
  readonly pager: Option.Option<DiffPager>;
  readonly hunk: boolean;
  readonly delta: boolean;
  readonly noPager: boolean;
}

/** Resolve the pager for one invocation: explicit flags win, otherwise the configured default. */
export const selectPager = Effect.fn("Cli.selectPager")(function* (choice: PagerChoice) {
  const requested: DiffPager[] = [];
  if (Option.isSome(choice.pager)) requested.push(choice.pager.value);
  if (choice.hunk) requested.push("hunk");
  if (choice.delta) requested.push("delta");
  const selected = [...new Set(requested)];
  if (selected.length > 1) return yield* bail("choose only one diff pager: --hunk, --delta, or --pager");
  if (choice.noPager) {
    if (selected.length > 0) return yield* bail("--no-pager cannot be combined with a pager flag");
    return undefined;
  }
  const paths = yield* Paths;
  return selected[0] ?? paths.diffPager;
});

/** An off-by-default switch: present means true, absent means false. */
export const switchFlag = (name: string, description: string) => Flag.boolean(name).pipe(Flag.withDefault(false), Flag.withDescription(description));

export const dryRunFlag = switchFlag("dry-run", "Print prospective actions without changing anything");
export const forceFlag = switchFlag("force", "Override drift and safety guards");
export const pullFlag = switchFlag("pull", "Compatibility flag; sync now pulls automatically");
export const skillsArg = Argument.string("skill").pipe(Argument.variadic({ min: 1 }));
export const optionalSkillsArg = Argument.string("skill").pipe(Argument.variadic({ min: 0 }));
export const pagerFlags = {
  pager: Flag.choice("pager", ["hunk", "delta"] as const).pipe(Flag.optional, Flag.withDescription("Open the patch in hunk or delta")),
  hunk: switchFlag("hunk", "Open the patch in Hunk"),
  delta: switchFlag("delta", "Open the patch in Delta"),
  noPager: switchFlag("no-pager", "Print inline, ignoring the configured diff pager"),
};
