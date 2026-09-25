import { cpSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { errorDetail, OperationFailed } from "../domain/model.ts";
import type { Manifest, SkillLockDecodeError, State } from "../domain/model.ts";
import {
  alignStateWithManifest,
  getActiveProfile,
  getProfile,
  getProfileOverrides,
  getSkill,
  profileNamePattern,
  promoteProfileOverrides,
  renameProfile,
  withAutoinvoke,
  withProfile,
  withProfileMembers,
  withSkillEnabled,
} from "../domain/model.ts";
import type { InvocationMode } from "../domain/model.ts";
import { ManifestStore } from "./manifest.ts";
import { applyUnlink, linkSkill, prepareUnlink, unlinkSkill } from "./linker.ts";
import type { LinkOptions } from "./linker.ts";
import { apply, observeAndPlan } from "./reconcile.ts";
import { absorbGlobalSkillLockEntries, loadHostSkillLock, readSkillLockFile, restoreHostSkillLock } from "./skill-lock.ts";
import { vendorAccept, vendorRestore } from "./vendor-ops.ts";
import { HostRepo, Paths } from "./paths.ts";

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
  const next = names.reduce((current, name) => withSkillEnabled(manifest, current, name, enabled), state);
  return yield* changeState(manifest, next, options);
});

export const setAutoinvoke = Effect.fn("Catalog.setAutoinvoke")(function* (name: string, mode: InvocationMode, options: MutationOptions = {}) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  if (!getSkill(manifest, name)) return yield* Effect.fail(new OperationFailed({ message: `unknown skill: ${name}` }));
  const result = yield* changeState(manifest, withAutoinvoke(state, name, mode), options);
  return { ...result, messages: [...result.messages, `${name}: OpenCode autoinvoke ${mode}`] };
});

export const applyProfile = Effect.fn("Catalog.applyProfile")(function* (name: string, options: MutationOptions = {}) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  if (!getProfile(manifest, name)) return yield* Effect.fail(new OperationFailed({ message: `unknown profile: ${name}` }));
  return yield* changeState(manifest, withProfile(manifest, state, name), options);
});

const bail = (message: string) => Effect.fail(new OperationFailed({ message }));

const checkProfileName = (name: string) => (profileNamePattern.test(name) ? Effect.void : bail(`profile names use letters, digits, ".", "_" and "-": ${name}`));

/** Write a profile's exact membership, then reconcile this machine if it follows that profile. */
const writeProfile = Effect.fn("Catalog.writeProfile")(function* (manifest: Manifest, state: State, name: string, members: ReadonlySet<string>, options: MutationOptions) {
  const store = yield* ManifestStore;
  for (const skill of members) {
    if (!getSkill(manifest, skill)) return yield* bail(`unknown skill: ${skill}`);
  }
  if (members.size === 0) return yield* bail(`profile ${name} would be empty; delete it instead`);
  const current = getProfile(manifest, name) ?? [];
  const nextManifest = withProfileMembers(manifest, name, members);
  const added = [...members].filter((skill) => !current.includes(skill)).sort();
  const dropped = current.filter((skill) => !members.has(skill)).sort();
  const summary = `profile ${name}${current.length === 0 ? " (new)" : ""}: ${[...added.map((skill) => `+${skill}`), ...dropped.map((skill) => `-${skill}`)].join(" ") || "unchanged"}`;
  if (!options.dryRun) yield* store.saveManifest(nextManifest);
  const result = yield* changeState(nextManifest, alignStateWithManifest(nextManifest, state), options);
  return { ...result, messages: [summary, ...result.messages] };
});

/**
 * Change a shared profile's membership in the manifest (committed by the next
 * save), then reconcile this machine if it follows that profile.
 */
export const editProfile = Effect.fn("Catalog.editProfile")(function* (
  name: string,
  additions: ReadonlyArray<string>,
  removals: ReadonlyArray<string>,
  options: MutationOptions = {},
) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  if (!getProfile(manifest, name)) yield* checkProfileName(name);
  for (const skill of [...additions, ...removals]) {
    if (!getSkill(manifest, skill)) return yield* bail(`unknown skill: ${skill}`);
  }
  const members = new Set([...(getProfile(manifest, name) ?? []), ...additions]);
  for (const skill of removals) members.delete(skill);
  return yield* writeProfile(manifest, state, name, members, options);
});

/** Replace a profile's membership exactly; `create` refuses an existing name, otherwise the profile must exist. */
export const setProfileMembers = Effect.fn("Catalog.setProfileMembers")(function* (
  name: string,
  members: ReadonlyArray<string>,
  mode: "create" | "replace",
  options: MutationOptions = {},
) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  const exists = getProfile(manifest, name) !== undefined;
  if (mode === "create") {
    yield* checkProfileName(name);
    if (exists) return yield* bail(`profile ${name} already exists`);
  } else if (!exists) return yield* bail(`unknown profile: ${name}`);
  return yield* writeProfile(manifest, state, name, new Set(members), options);
});

export const renameProfileAction = Effect.fn("Catalog.renameProfile")(function* (from: string, to: string, options: MutationOptions = {}) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  if (!getProfile(manifest, from)) return yield* bail(`unknown profile: ${from}`);
  yield* checkProfileName(to);
  if (getProfile(manifest, to)) return yield* bail(`profile ${to} already exists`);
  const renamed = renameProfile(manifest, state, from, to);
  if (!options.dryRun) yield* store.saveManifest(renamed.manifest);
  const result = yield* changeState(renamed.manifest, renamed.state, options);
  return { ...result, messages: [`profile ${from} renamed to ${to}`, ...result.messages] };
});

/** Remove a profile from the manifest; refuses the one this machine follows. */
export const deleteProfile = Effect.fn("Catalog.deleteProfile")(function* (name: string, options: MutationOptions = {}) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  if (!getProfile(manifest, name)) return yield* bail(`unknown profile: ${name}`);
  if (getActiveProfile(manifest, state) === name) return yield* bail(`this machine follows ${name}; follow another profile before deleting it`);
  if (!options.dryRun) yield* store.saveManifest(withProfileMembers(manifest, name, []));
  return { messages: [`profile ${name} deleted`], warnings: [], dryRun: options.dryRun ?? false } satisfies ActionResult;
});

/** Fold this machine's local profile changes into the shared profile. */
export const promoteProfile = Effect.fn("Catalog.promoteProfile")(function* (options: MutationOptions = {}) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  const profile = getActiveProfile(manifest, state);
  if (profile === null) return yield* Effect.fail(new OperationFailed({ message: "this machine is not following a profile; run `slinky profile apply <name>` first" }));
  const { enabled, disabled } = getProfileOverrides(state);
  if (enabled.length === 0 && disabled.length === 0) {
    return { messages: [`no local changes to promote into ${profile}`], warnings: [], dryRun: options.dryRun ?? false } satisfies ActionResult;
  }
  const promoted = promoteProfileOverrides(manifest, state);
  const summary = `profile ${profile}: ${[...enabled.map((skill) => `+${skill}`), ...disabled.map((skill) => `-${skill}`)].join(" ")}`;
  if (!options.dryRun) yield* store.saveManifest(promoted.manifest);
  const result = yield* changeState(promoted.manifest, promoted.state, options);
  return { ...result, messages: [summary, ...result.messages] };
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

export interface AcceptVendorOptions {
  readonly refreshProvenance?: boolean;
  readonly absorbProvenance?: boolean;
}

export const acceptVendorDrifts = Effect.fn("Catalog.acceptVendorDrifts")(function* (names: ReadonlyArray<string>, options: AcceptVendorOptions = {}) {
  const store = yield* ManifestStore;
  const { repo } = yield* HostRepo;
  const paths = yield* Paths;
  const initialManifest = yield* store.loadManifest();
  const manifestFile = yield* store.snapshotManifestFile();
  const hostLock = yield* loadHostSkillLock();
  const provenance = options.refreshProvenance ? readSkillLockFile(paths.skillLock) : undefined;
  const uniqueNames = [...new Set(names)];
  const directory = mkdtempSync(join(tmpdir(), "slinky-vendor-accept-"));
  const baselines = yield* Effect.try({
    try: () =>
      uniqueNames.map((name, index) => {
        const meta = getSkill(initialManifest, name);
        if (!meta) throw new OperationFailed({ message: `unknown skill: ${name}` });
        if (meta.origin !== "vendor") throw new OperationFailed({ message: `${name} is a local skill; nothing to vendor` });
        const path = join(repo, meta.path);
        const backup = join(directory, String(index));
        cpSync(path, backup, { recursive: lstatSync(path).isDirectory(), preserveTimestamps: true });
        return { path, backup };
      }),
    catch: (error) => (error instanceof OperationFailed ? error : new OperationFailed({ message: `could not snapshot vendor baselines: ${errorDetail(error)}` })),
  }).pipe(Effect.onError(() => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))));

  let manifest = initialManifest;
  const accepted: Array<{ readonly name: string; readonly changed: boolean; readonly warning?: SkillLockDecodeError }> = [];
  let lockTouched = false;
  const committed = yield* Effect.exit(
    Effect.gen(function* () {
      for (const name of uniqueNames) {
        const result = yield* vendorAccept(manifest, name, provenance ? { refreshProvenance: true, provenance } : {});
        manifest = result.manifest;
        accepted.push(result.warning ? { name, changed: result.changed, warning: result.warning } : { name, changed: result.changed });
      }
      if (options.absorbProvenance && uniqueNames.length > 0) {
        const changedNames = accepted.filter((result) => result.changed).map((result) => result.name);
        lockTouched = true;
        yield* absorbGlobalSkillLockEntries(manifest, changedNames, provenance);
      }
      yield* store.saveManifest(manifest);
    }),
  );
  if (Exit.isFailure(committed)) {
    const failures: string[] = [];
    for (const baseline of baselines) {
      try {
        rmSync(baseline.path, { recursive: true, force: true });
        mkdirSync(dirname(baseline.path), { recursive: true });
        cpSync(baseline.backup, baseline.path, { recursive: lstatSync(baseline.backup).isDirectory(), preserveTimestamps: true });
      } catch (error) {
        failures.push(`${baseline.path}: ${errorDetail(error)}`);
      }
    }
    const restoredManifest = yield* Effect.exit(store.restoreManifestFile(manifestFile));
    if (Exit.isFailure(restoredManifest)) failures.push(`manifest: ${errorDetail(Cause.squash(restoredManifest.cause))}`);
    if (lockTouched) {
      const restoredLock = yield* Effect.exit(restoreHostSkillLock(hostLock));
      if (Exit.isFailure(restoredLock)) failures.push(`lock: ${errorDetail(Cause.squash(restoredLock.cause))}`);
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(`${directory}: ${errorDetail(error)}`);
    }
    if (failures.length > 0) {
      return yield* Effect.fail(new OperationFailed({ message: `${errorDetail(Cause.squash(committed.cause))}; compensation also failed: ${failures.join("; ")}` }));
    }
    return yield* Effect.failCause(committed.cause);
  }
  const warnings: string[] = [];
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    warnings.push(`could not remove vendor transaction snapshot ${directory}: ${errorDetail(error)}`);
  }
  return { manifest, accepted, warnings };
});

export const acceptVendorDrift = Effect.fn("Catalog.acceptVendorDrift")(function* (name: string) {
  const result = yield* acceptVendorDrifts([name]);
  const accepted = result.accepted[0];
  if (!accepted) return yield* Effect.fail(new OperationFailed({ message: `${name} was not accepted` }));
  return { changed: accepted.changed, warning: accepted.warning, warnings: result.warnings };
});

export const restoreVendorDrift = Effect.fn("Catalog.restoreVendorDrift")(function* (name: string) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  yield* vendorRestore(manifest, name);
});
