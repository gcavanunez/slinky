import { Effect } from "effect";
import { OperationFailed } from "../domain/model.ts";
import type { Manifest, State } from "../domain/model.ts";
import { getProfile, getSkill, ManifestStore, withProfile, withSkillEnabled } from "./manifest.ts";
import { applyUnlink, linkSkill, prepareUnlink, unlinkSkill } from "./linker.ts";
import type { LinkOptions } from "./linker.ts";
import { apply, observeAndPlan } from "./reconcile.ts";
import { vendorAccept, vendorRestore } from "./vendorOps.ts";

export interface ActionResult {
  readonly messages: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly dryRun: boolean;
}

export interface MutationOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

const changeState = Effect.fn("Catalog.changeState")(function* (manifest: Manifest, next: State, options: MutationOptions) {
  const store = yield* ManifestStore;
  const plan = yield* observeAndPlan(manifest, next, { force: options.force ?? false });
  if (options.dryRun) {
    return {
      messages: plan.actions.map((action) => `${action.type} ${action.skill}`),
      warnings: plan.warnings,
      dryRun: true,
    } satisfies ActionResult;
  }

  yield* store.saveState(next);
  const result = yield* apply(plan, { force: options.force ?? false });
  return {
    messages: result.done,
    warnings: [...plan.warnings, ...result.skipped],
    dryRun: false,
  } satisfies ActionResult;
});

export const setSkillsEnabled = Effect.fn("Catalog.setSkillsEnabled")(function* (names: ReadonlyArray<string>, enabled: boolean, options: MutationOptions = {}) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  for (const name of names) {
    if (!getSkill(manifest, name)) return yield* Effect.fail(new OperationFailed({ message: `unknown skill: ${name}` }));
  }
  const next = names.reduce((current, name) => withSkillEnabled(current, name, enabled), state);
  return yield* changeState(manifest, next, options);
});

export const applyProfile = Effect.fn("Catalog.applyProfile")(function* (name: string, options: MutationOptions = {}) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  if (!getProfile(manifest, name)) return yield* Effect.fail(new OperationFailed({ message: `unknown profile: ${name}` }));
  return yield* changeState(manifest, withProfile(manifest, state, name), options);
});

export const linkProjectSkill = Effect.fn("Catalog.linkProjectSkill")(function* (options: LinkOptions) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  const result = yield* linkSkill(manifest, state, options);
  yield* store.saveState(result.state).pipe(
    // Persisting failed: undo the paths the link just created.
    Effect.onError(() => unlinkSkill(manifest, result.state, result.link.skill, result.link.project, { force: true }).pipe(Effect.ignore)),
  );
  return { link: result.link };
});

export const unlinkProjectSkill = Effect.fn("Catalog.unlinkProjectSkill")(function* (skill: string, project: string, options: { readonly force?: boolean } = {}) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  const result = yield* prepareUnlink(manifest, state, skill, project, options);
  yield* store.saveState(result.state);
  const warnings = yield* Effect.sync(() => applyUnlink(result.link)).pipe(
    // Removal failed: restore the previously persisted state.
    Effect.onError(() => store.saveState(state).pipe(Effect.ignore)),
  );
  return { link: result.link, warnings };
});

export const acceptVendorDrift = Effect.fn("Catalog.acceptVendorDrift")(function* (name: string) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const result = yield* vendorAccept(manifest, name);
  yield* store.saveManifest(result.manifest);
  return { changed: result.changed, warning: result.warning };
});

export const restoreVendorDrift = Effect.fn("Catalog.restoreVendorDrift")(function* (name: string) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  yield* vendorRestore(manifest, name);
});
