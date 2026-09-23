import { Effect } from "effect";
import { OperationFailed } from "../domain/model.ts";
import { adoptSkills, findForeign } from "./adopt.ts";
import type { AdoptOptions, ForeignSkill } from "./adopt.ts";
import { ManifestStore } from "./manifest.ts";
import { reconcileCatalog } from "./reconcile.ts";

export interface ForeignAdoptionResult {
  readonly name: string;
  readonly path: string;
  readonly messages: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

/** Adopt one currently-foreign global skill and reconcile it into the canonical stores. */
export const adoptForeignSkill = Effect.fn("ForeignAdoption.adoptForeignSkill")(function* (selected: ForeignSkill, options: AdoptOptions = {}) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  const scan = yield* findForeign(manifest);
  const candidate = scan.candidates.find((skill) => skill.name === selected.name && skill.location === selected.location && skill.dir === selected.dir);
  if (!candidate) return yield* Effect.fail(new OperationFailed({ message: `${selected.name} is no longer available to adopt; refresh the catalog` }));

  const adoption = yield* adoptSkills(store, manifest, state, [{ candidate, options }]);
  const adopted = adoption.adopted[0];
  if (!adopted) return yield* Effect.fail(new OperationFailed({ message: `${selected.name} was not adopted` }));

  const reconciliation = yield* reconcileCatalog(adoption.manifest, adoption.state);
  if (!reconciliation.applied) return yield* Effect.fail(new OperationFailed({ message: `${selected.name} was not reconciled` }));
  const warnings = [...(scan.warning ? [scan.warning.message] : []), ...adoption.warnings, ...reconciliation.plan.warnings, ...reconciliation.applied.skipped];
  return {
    name: selected.name,
    path: adopted.path,
    messages: reconciliation.applied.done,
    warnings,
  } satisfies ForeignAdoptionResult;
});
