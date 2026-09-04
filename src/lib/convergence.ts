import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { Cause, Effect, Exit, Schema } from "effect";
import { alignStateForTransition, alignStateWithManifest, errorDetail, ExternalToolError, isMissingFile, Manifest, OperationFailed, withSkillEnabled } from "../domain/model.ts";
import type { State } from "../domain/model.ts";
import { planSync } from "../domain/reconcile-plan.ts";
import type { Plan } from "../domain/reconcile-plan.ts";
import { findUnindexedSkills } from "./adopt.ts";
import { assertGitRoot, conflictedPaths, requireCleanWorktree, requireUpstream, runGit, temporaryWorktree, tryGit } from "./git.ts";
import { contentHash, findSymlinks, walkFiles } from "./hash.ts";
import { ManifestStore } from "./manifest.ts";
import { HostRepo, Paths } from "./paths.ts";
import { apply, observe, reconcileCatalog } from "./reconcile.ts";
import { refreshLocalHashes } from "./rehash.ts";
import {
  ensureHostSkillLock,
  loadHostSkillLock,
  loadSkillLockFile,
  previewHostSkillLock,
  pruneGlobalSkillLockEntries,
  readSkillLockFile,
  restoreGlobalSkillLock,
  seedGlobalSkillLock,
  skillLockVersion,
  validateSkillLock,
} from "./skill-lock.ts";
import type { SkillLockEntry, SkillLockSnapshot } from "./skill-lock.ts";
import { findDriftingVendors, vendorRestore } from "./vendor-ops.ts";

export type ConvergenceTone = "dim" | "error" | "success" | "warning";

export type ConvergenceEvent =
  | { readonly type: "section"; readonly title: "save" | "pull" | "reconcile" | "restore" | "finalize"; readonly leadingBlank: boolean }
  | { readonly type: "message"; readonly message: string; readonly tone?: ConvergenceTone }
  | { readonly type: "git-output"; readonly stdout: string; readonly stderr: string };

export type ConvergenceEventSink = (event: ConvergenceEvent) => void;

interface OperationOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly onEvent?: ConvergenceEventSink;
}

export interface SaveCatalogOptions {
  readonly message?: string;
  readonly onEvent?: ConvergenceEventSink;
}

export interface PullCatalogOptions extends OperationOptions {}

export interface PushCatalogOptions {
  readonly dryRun?: boolean;
  readonly onEvent?: ConvergenceEventSink;
}

export interface SyncCatalogOptions extends OperationOptions {}

export interface SaveCatalogReport {
  readonly changed: boolean;
  readonly revision?: string;
}

export interface CatalogStateReport {
  readonly manifest: Manifest;
  readonly state: State;
}

export interface PushCatalogReport {
  readonly upstream: string;
  readonly dryRun: boolean;
}

export interface SyncCatalogReport {
  readonly restored: ReadonlyArray<string>;
}

const bail = (message: string) => Effect.fail(new OperationFailed({ message }));

const send = (sink: ConvergenceEventSink | undefined, event: ConvergenceEvent) =>
  Effect.sync(() => {
    try {
      sink?.(event);
    } catch {
      // Presentation failures cannot participate in catalog transactions.
    }
  });

const message = (sink: ConvergenceEventSink | undefined, text: string, tone?: ConvergenceTone) =>
  send(sink, tone === undefined ? { type: "message", message: text } : { type: "message", message: text, tone });

const section = (sink: ConvergenceEventSink | undefined, title: Extract<ConvergenceEvent, { type: "section" }>["title"], leadingBlank: boolean) =>
  send(sink, { type: "section", title, leadingBlank });

const loadHostState = Effect.gen(function* () {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  return { store, manifest, state };
});

const emitGitOutput = (sink: ConvergenceEventSink | undefined, result: { readonly stdout: string; readonly stderr: string }) => {
  if (!`${result.stdout}${result.stderr}`.trim()) return Effect.void;
  return send(sink, { type: "git-output", stdout: result.stdout, stderr: result.stderr });
};

const loadCommittedManifest = Effect.fn("Convergence.loadCommittedManifest")(function* (repo: string) {
  const committed = yield* runGit(repo, ["show", "HEAD:skills.manifest.json"]);
  return yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Manifest)(JSON.parse(committed.stdout)),
    catch: (error) => new OperationFailed({ message: `cannot decode committed skills.manifest.json: ${errorDetail(error)}` }),
  });
});

const verifyCatalogAt = Effect.fn("Convergence.verifyCatalogAt")(function* (
  repo: string,
  catalogLock: string,
  manifest: Manifest,
  sink: ConvergenceEventSink | undefined,
  requireLock = false,
  projectedLock?: SkillLockSnapshot,
) {
  let bad = 0;
  for (const [name, meta] of Object.entries(manifest.skills)) {
    const repoPath = join(repo, meta.path);
    if (!existsSync(repoPath)) {
      yield* message(sink, `${name}: repo copy missing at ${meta.path}`, "error");
      bad++;
      continue;
    }
    const stat = lstatSync(repoPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      yield* message(sink, `${name}: repo path must be a real directory: ${meta.path}`, "error");
      bad++;
      continue;
    }
    const symlinks = findSymlinks(repoPath);
    if (symlinks.length > 0) {
      yield* message(sink, `${name}: repo copy contains symlink(s): ${symlinks.join(", ")}`, "error");
      bad++;
      continue;
    }
    if (contentHash(repoPath) !== meta.contentHash) {
      yield* message(sink, `${name}: repo copy hash mismatch (manifest stale?)`, "warning");
      bad++;
    }
  }
  const lock = projectedLock ?? (yield* loadSkillLockFile(catalogLock));
  if (requireLock && !lock.exists) {
    yield* message(sink, ".skill-lock.json is missing; run `slinky save` to create and commit it", "warning");
    bad++;
  }
  for (const issue of validateSkillLock(manifest, lock)) {
    yield* message(sink, issue, "warning");
    bad++;
  }
  if (bad > 0) return yield* bail(`${bad} catalog verification problem(s)`);
  yield* message(sink, `all ${Object.keys(manifest.skills).length} skills verified`, "success");
});

export const verifyCatalog = Effect.fn("Convergence.verifyCatalog")(function* (onEvent?: ConvergenceEventSink) {
  const { repo, catalogLock } = yield* HostRepo;
  const { manifest } = yield* loadHostState;
  yield* verifyCatalogAt(repo, catalogLock, manifest, onEvent);
});

const renderReconciliation = Effect.fn("Convergence.renderReconciliation")(function* (manifest: Manifest, state: State, options: OperationOptions) {
  const { plan, applied } = yield* reconcileCatalog(manifest, state, options);
  for (const warning of plan.warnings) yield* message(options.onEvent, `warn: ${warning}`, "warning");
  if (options.dryRun) {
    if (plan.actions.length === 0) yield* message(options.onEvent, "nothing to do");
    for (const action of plan.actions) yield* message(options.onEvent, `would ${action.type} ${action.skill}`);
    return;
  }
  if (!applied) return;
  for (const done of applied.done) yield* message(options.onEvent, `  ${done}`);
  for (const skipped of applied.skipped) yield* message(options.onEvent, `  skipped: ${skipped}`, "warning");
  if (applied.done.length === 0 && applied.skipped.length === 0) yield* message(options.onEvent, "in sync; nothing to do");
});

const seedVerifiedGlobalProvenance = Effect.fn("Convergence.seedVerifiedGlobalProvenance")(function* (manifest: Manifest) {
  const paths = yield* Paths;
  const names = yield* Effect.try({
    try: () =>
      Object.entries(manifest.skills)
        .filter(([name, skill]) => {
          if (skill.origin !== "vendor") return false;
          const live = join(paths.agentsSkills, name);
          if (!existsSync(live)) return false;
          const stat = lstatSync(live);
          return stat.isDirectory() && !stat.isSymbolicLink() && contentHash(live) === skill.contentHash;
        })
        .map(([name]) => name),
    catch: (error) => new OperationFailed({ message: `could not verify live vendor provenance: ${errorDetail(error)}` }),
  });
  if (names.length > 0) yield* seedGlobalSkillLock(manifest, names);
});

interface PullOptions extends OperationOptions {
  readonly restoreDrift: boolean;
}

const prepareRetirement = Effect.fn("Convergence.prepareRetirement")(function* (manifest: Manifest, state: State, removed: ReadonlyArray<string>, options: PullOptions) {
  if (removed.length === 0) return { actions: [], warnings: [] } satisfies Plan;
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;
  const observation = yield* observe();
  const removalState = removed.reduce((current, name) => withSkillEnabled(manifest, current, name, false), state);
  const fullPlan = planSync(manifest, removalState, observation, { repo, claudeSkills: paths.claudeSkills, force: options.force ?? false });
  const names = new Set(removed);
  const retirementRank = (action: Plan["actions"][number]): number => (action.type === "remove-agents" ? 0 : action.type === "remove-claude" ? 1 : 2);
  const plan = {
    actions: fullPlan.actions
      .filter((action) => names.has(action.skill))
      .map((action) => {
        if (action.type === "remove-agents") {
          const live = observation.agents[action.skill];
          const meta = manifest.skills[action.skill];
          if (options.restoreDrift && meta?.origin === "vendor" && live?.kind === "dir") return { type: "remove-agents" as const, skill: action.skill };
          return live?.kind === "symlink" || live?.kind === "broken-symlink" ? { ...action, expectedTarget: live.resolved } : action;
        }
        if (action.type === "remove-claude") {
          const live = observation.claude[action.skill];
          return live?.kind === "symlink" || live?.kind === "broken-symlink" ? { ...action, expectedTarget: live.resolved } : action;
        }
        return action;
      })
      .sort((left, right) => retirementRank(left) - retirementRank(right)),
    warnings: fullPlan.warnings.filter((warning) => removed.some((name) => warning.startsWith(`${name}:`))),
  };
  if (plan.warnings.length > 0) return yield* bail(`cannot retire unowned skill paths: ${plan.warnings.join("; ")}`);

  for (const name of removed) {
    const meta = manifest.skills[name];
    if (!meta) continue;
    const live = observation.agents[name];
    const restoreRetiredVendor = options.restoreDrift && meta.origin === "vendor";
    if (live?.kind === "dir" && contentHash(join(paths.agentsSkills, name)) !== meta.contentHash && !options.force && !restoreRetiredVendor) {
      return yield* bail(`${name}: live dir drifted from repo copy; run \`diff ${name}\` then \`vendor ${name}\` or use --force`);
    }
    const repoPath = resolve(repo, meta.path);
    if ((live?.kind === "symlink" || live?.kind === "broken-symlink") && live.resolved !== repoPath && !options.force) {
      return yield* bail(`${name}: ~/.agents/skills symlink is not owned by this catalog; inspect it or use --force`);
    }
    const claude = observation.claude[name];
    const expectedClaudeTarget = resolve(paths.agentsSkills, name);
    if ((claude?.kind === "symlink" || claude?.kind === "broken-symlink") && claude.resolved !== expectedClaudeTarget && !options.force) {
      return yield* bail(`${name}: ~/.claude/skills symlink targets ${claude.resolved ?? "a missing path"}, expected ${expectedClaudeTarget}; inspect it or use --force`);
    }
  }
  if (options.dryRun) for (const action of plan.actions) yield* message(options.onEvent, `would ${action.type} retired skill ${action.skill}`);
  return plan;
});

const applyRetirement = Effect.fn("Convergence.applyRetirement")(function* (
  manifest: Manifest,
  oldLockEntries: Readonly<Record<string, SkillLockEntry>>,
  removed: ReadonlyArray<string>,
  plan: Plan,
  options: PullOptions,
) {
  const result = yield* apply(plan, { force: options.force ?? false });
  for (const done of result.done) yield* message(options.onEvent, `  ${done}`);
  if (result.skipped.length > 0) return yield* bail(`retired skill cleanup changed after preflight: ${result.skipped.join("; ")}`);
  yield* pruneGlobalSkillLockEntries(manifest, oldLockEntries, removed, options.force ?? false);
});

const loadIncomingCatalog = Effect.fn("Convergence.loadIncomingCatalog")(function* (repo: string, commit: string, sink: ConvergenceEventSink | undefined) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const checkout = yield* temporaryWorktree(repo, "slinky-pull-", commit);
      const manifest = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(join(checkout, "skills.manifest.json"), "utf8")), { errors: "all", onExcessProperty: "error" }),
        catch: (error) => new OperationFailed({ message: `incoming skills.manifest.json is invalid: ${errorDetail(error)}` }),
      });
      yield* verifyCatalogAt(checkout, join(checkout, ".skill-lock.json"), manifest, sink, true);
      return manifest;
    }),
  );
});

const loadCatalogTree = Effect.fn("Convergence.loadCatalogTree")(function* (repo: string, tree: string, sink: ConvergenceEventSink | undefined) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const checkout = yield* temporaryWorktree(repo, "slinky-merge-", "HEAD");
      yield* runGit(checkout, ["read-tree", "--reset", tree]);
      yield* Effect.sync(() => {
        for (const entry of readdirSync(checkout)) if (entry !== ".git") rmSync(join(checkout, entry), { recursive: true, force: true });
      });
      yield* runGit(checkout, ["checkout-index", "--all", "--force"]);
      const manifest = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(join(checkout, "skills.manifest.json"), "utf8")), { errors: "all", onExcessProperty: "error" }),
        catch: (error) => new OperationFailed({ message: `merged skills.manifest.json is invalid: ${errorDetail(error)}` }),
      });
      yield* verifyCatalogAt(checkout, join(checkout, ".skill-lock.json"), manifest, sink, true);
      return manifest;
    }),
  );
});

const rebaseDivergence = Effect.fn("Convergence.rebaseDivergence")(function* (
  repo: string,
  upstream: string,
  upstreamCommit: string,
  manifest: Manifest,
  ahead: number,
  options: PullOptions,
) {
  // Prove and verify the combined tree before allowing Git to rewrite the local commits.
  const manually = `resolve them with Git before pulling: git rebase ${upstream}`;
  const merge = yield* tryGit(repo, ["merge-tree", "--write-tree", upstreamCommit, "HEAD"]);
  if (merge.status !== 0) {
    const paths = conflictedPaths(merge.stdout);
    const detail = paths.length > 0 ? ` (conflicts in ${paths.join(", ")})` : "";
    return yield* bail(`local branch and ${upstream} have diverged and do not merge cleanly${detail}; ${manually}`);
  }
  const tree = merge.stdout.split("\n")[0]?.trim();
  if (!tree) return yield* bail(`could not compute a merge of HEAD and ${upstream}; ${manually}`);
  const merged = yield* loadCatalogTree(repo, tree, options.onEvent);
  const retired = Object.keys(manifest.skills).filter((name) => !Object.hasOwn(merged.skills, name));
  if (retired.length > 0) return yield* bail(`local branch and ${upstream} have diverged and the merge retires ${retired.join(", ")}; ${manually}`);
  if (options.dryRun) {
    yield* message(options.onEvent, `would replay ${ahead} local commit(s) onto ${upstream}`);
    return merged;
  }
  const before = (yield* runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
  yield* message(options.onEvent, `diverged from ${upstream}; replaying ${ahead} local commit(s) onto it`);
  const rebase = yield* tryGit(repo, ["rebase", upstreamCommit]);
  if (rebase.status !== 0) {
    // merge-tree proves the final tree, but an individual commit can still fail to replay.
    yield* tryGit(repo, ["rebase", "--abort"]).pipe(Effect.ignore);
    return yield* bail(`could not replay local commits onto ${upstream}; branch left at ${before.slice(0, 7)}; ${manually}`);
  }
  yield* message(options.onEvent, `replayed ${ahead} commit(s); previous branch tip was ${before.slice(0, 7)}`);
});

const pullCatalogInternal = Effect.fn("Convergence.pullCatalogInternal")(function* (options: PullOptions) {
  const { repo, catalogLock } = yield* HostRepo;
  const { store, manifest: loadedManifest, state: loadedState } = yield* loadHostState;
  let currentManifest = loadedManifest;
  let currentState = loadedState;
  const paths = yield* Paths;
  yield* assertGitRoot(repo);
  yield* requireCleanWorktree(repo);
  yield* verifyCatalogAt(repo, catalogLock, currentManifest, options.onEvent);
  let currentHostLock = yield* loadHostSkillLock();
  if (!currentHostLock.exists) return yield* bail(".skill-lock.json is missing; run `slinky save` before pulling");
  const globalLock = readSkillLockFile(paths.skillLock);
  if (globalLock.warning) return yield* Effect.fail(globalLock.warning);
  if (globalLock.exists && globalLock.version !== skillLockVersion) return yield* bail(`machine skill lock version ${globalLock.version} is not supported for writes`);
  const { upstream, remote, mergeRef } = yield* requireUpstream(repo);
  yield* emitGitOutput(options.onEvent, yield* runGit(repo, ["fetch", remote, mergeRef]));
  const upstreamCommit = (yield* runGit(repo, ["rev-parse", "FETCH_HEAD^{commit}"])).stdout.trim();

  const countAgainstUpstream = Effect.fn("Convergence.countAgainstUpstream")(function* () {
    const counts = (yield* runGit(repo, ["rev-list", "--left-right", "--count", `HEAD...${upstreamCommit}`])).stdout.trim().split(/\s+/);
    const ahead = Number.parseInt(counts[0] ?? "", 10);
    const behind = Number.parseInt(counts[1] ?? "", 10);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return yield* bail(`could not compare HEAD with ${upstream}`);
    return { ahead, behind };
  });

  let { ahead, behind } = yield* countAgainstUpstream();
  if (ahead > 0 && behind > 0) {
    const previousManifest = currentManifest;
    const mergedManifest = yield* rebaseDivergence(repo, upstream, upstreamCommit, currentManifest, ahead, options);
    if (options.dryRun) {
      const manifest = mergedManifest ?? currentManifest;
      return { manifest, state: alignStateForTransition(currentManifest, manifest, currentState) } satisfies CatalogStateReport;
    }
    currentManifest = yield* store.loadManifest();
    currentState = yield* store.loadStateForTransition(currentManifest, previousManifest);
    currentHostLock = yield* loadHostSkillLock();
    yield* verifyCatalogAt(repo, catalogLock, currentManifest, options.onEvent);
    ({ ahead, behind } = yield* countAgainstUpstream());
  }

  if (behind === 0) {
    yield* message(options.onEvent, ahead > 0 ? `already up to date from ${upstream}; local branch is ${ahead} commit(s) ahead` : `already up to date with ${upstream}`);
    if (!options.dryRun) {
      yield* store.saveState(currentState);
      yield* renderReconciliation(currentManifest, currentState, options);
      yield* seedVerifiedGlobalProvenance(currentManifest);
    }
    return { manifest: currentManifest, state: currentState } satisfies CatalogStateReport;
  }

  const incomingManifest = yield* loadIncomingCatalog(repo, upstreamCommit, options.onEvent);
  const removed = Object.keys(currentManifest.skills).filter((name) => !Object.hasOwn(incomingManifest.skills, name));
  const transitionState = yield* store.loadStateForTransition(incomingManifest, currentManifest);
  const linked = transitionState.projectLinks.filter((link) => removed.includes(link.skill));
  if (linked.length > 0) {
    const commands = linked.map((link) => `slinky unlink ${link.skill} ${link.project}`).join("; ");
    return yield* bail(`incoming catalog removes linked skills; unlink them before pulling: ${commands}`);
  }
  yield* message(options.onEvent, options.dryRun ? `would fast-forward ${behind} commit(s) from ${upstream}` : `fast-forwarding ${behind} commit(s) from ${upstream}`);
  const retirement = yield* prepareRetirement(currentManifest, transitionState, removed, options);
  const incomingState = alignStateWithManifest(incomingManifest, transitionState);
  if (options.dryRun) return { manifest: incomingManifest, state: incomingState } satisfies CatalogStateReport;
  const snapshot = yield* snapshotLocalSave({ previous: currentManifest, state: transitionState, removed, oldLockEntries: currentHostLock.entries, plan: retirement });
  const advanced = yield* Effect.exit(
    Effect.gen(function* () {
      yield* applyRetirement(currentManifest, currentHostLock.entries, removed, retirement, options);
      yield* store.saveState(incomingState);
      yield* emitGitOutput(options.onEvent, yield* runGit(repo, ["merge", "--ff-only", upstreamCommit]));
    }),
  );
  if (Exit.isFailure(advanced)) {
    const restored = yield* Effect.exit(restoreLocalSave(snapshot));
    yield* cleanupLocalSaveSnapshot(snapshot, options.onEvent);
    if (Exit.isFailure(restored)) {
      return yield* Effect.fail(
        new OperationFailed({
          message: `${errorDetail(Cause.squash(advanced.cause))}; compensation also failed: ${errorDetail(Cause.squash(restored.cause))}`,
        }),
      );
    }
    return yield* Effect.failCause(advanced.cause);
  }
  yield* cleanupLocalSaveSnapshot(snapshot, options.onEvent);
  const manifest = yield* store.loadManifest();
  yield* renderReconciliation(manifest, incomingState, options);
  yield* seedVerifiedGlobalProvenance(manifest);
  return { manifest, state: incomingState } satisfies CatalogStateReport;
});

export const pullCatalog = Effect.fn("Convergence.pullCatalog")(function* (options: PullCatalogOptions = {}) {
  return yield* pullCatalogInternal({ ...options, restoreDrift: false });
});

const saveCatalogInternal = Effect.fn("Convergence.saveCatalogInternal")(function* (options: SaveCatalogOptions) {
  const store = yield* ManifestStore;
  let manifest = yield* store.loadManifest();
  const { repo, catalogLock } = yield* HostRepo;
  yield* assertGitRoot(repo);
  const unindexed = findUnindexedSkills(manifest, repo).filter((skill) => skill.origin !== "agent");
  if (unindexed.length > 0) return yield* bail(`unindexed catalog skill: ${unindexed.map((skill) => skill.path).join(", ")}`);
  yield* ensureHostSkillLock(manifest);
  const refresh = refreshLocalHashes(manifest, repo);
  if (refresh.refreshed.length > 0) {
    manifest = refresh.manifest;
    for (const name of refresh.refreshed) yield* message(options.onEvent, `${name}: refreshed manifest hash`);
    yield* store.saveManifest(manifest);
  }
  yield* verifyCatalogAt(repo, catalogLock, manifest, options.onEvent);
  const previous = yield* loadCommittedManifest(repo);
  const previousPaths = Object.values(previous.skills).map((skill) => skill.path);
  const committedFiles = yield* runGit(repo, ["ls-tree", "-r", "--name-only", "HEAD", "--", ...previousPaths]);
  const currentFiles = Object.values(manifest.skills).flatMap((skill) => walkFiles(join(repo, skill.path)).map((file) => posix.join(skill.path, file)));
  const pathspec = [".skill-lock.json", "skills.manifest.json", ...new Set([...committedFiles.stdout.split("\n").filter(Boolean), ...currentFiles])];
  const status = yield* runGit(repo, ["status", "--porcelain", "--", ...pathspec]);
  if (status.stdout.trim().length === 0) {
    yield* message(options.onEvent, "catalog already saved; nothing to commit", "success");
    return { changed: false } satisfies SaveCatalogReport;
  }

  const index = yield* runGit(repo, ["rev-parse", "--git-path", "index"]);
  const indexPath = resolve(repo, index.stdout.trim());
  const indexBackup = `${indexPath}.slinky-${process.pid}`;
  yield* Effect.try({
    try: () => copyFileSync(indexPath, indexBackup),
    catch: (error) => new ExternalToolError({ tool: "git", message: `could not back up Git index: ${errorDetail(error)}` }),
  });
  const commit = yield* Effect.gen(function* () {
    yield* runGit(repo, ["add", "--intent-to-add", "--", ".skill-lock.json", "skills.manifest.json", ...currentFiles]);
    return yield* runGit(repo, ["commit", "--only", "-m", options.message ?? "Update skills catalog", "--", ...pathspec]);
  }).pipe(
    Effect.catch((commitError) =>
      Effect.try({
        try: () => {
          const restore = `${indexPath}.slinky-restore-${process.pid}`;
          copyFileSync(indexBackup, restore);
          renameSync(restore, indexPath);
          rmSync(indexBackup, { force: true });
        },
        catch: (restoreError) =>
          new ExternalToolError({
            tool: "git",
            message: `${commitError.message}; failed to restore Git index: ${errorDetail(restoreError)} (backup retained at ${indexBackup})`,
          }),
      }).pipe(Effect.andThen(Effect.fail(commitError))),
    ),
  );
  try {
    rmSync(indexBackup, { force: true });
  } catch (error) {
    yield* message(options.onEvent, `warn: commit succeeded, but could not remove Git index backup ${indexBackup}: ${errorDetail(error)}`, "warning");
  }
  if (commit.stdout.trim()) yield* message(options.onEvent, commit.stdout.trim());
  const revision = (yield* runGit(repo, ["rev-parse", "--short", "HEAD"])).stdout.trim();
  yield* message(options.onEvent, `saved catalog as ${revision}`, "success");
  return { changed: true, revision } satisfies SaveCatalogReport;
});

const inspectSyncGit = Effect.fn("Convergence.inspectSyncGit")(function* () {
  const { repo } = yield* HostRepo;
  const topLevel = yield* tryGit(repo, ["rev-parse", "--show-toplevel"]);
  if (topLevel.status !== 0) return { isGitRoot: false, hasUpstream: false };
  if (realpathSync(topLevel.stdout.trim()) !== realpathSync(repo)) return yield* bail(`skills host must be a Git repository root: ${repo}`);
  const upstream = yield* tryGit(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  return { isGitRoot: true, hasUpstream: upstream.status === 0 };
});

const previewCatalogSave = Effect.fn("Convergence.previewCatalogSave")(function* (manifest: Manifest, options: SyncCatalogOptions) {
  const { repo, catalogLock } = yield* HostRepo;
  const unindexed = findUnindexedSkills(manifest, repo).filter((skill) => skill.origin !== "agent");
  if (unindexed.length > 0) return yield* bail(`unindexed catalog skill: ${unindexed.map((skill) => skill.path).join(", ")}`);
  const refresh = refreshLocalHashes(manifest, repo);
  const projectedLock = yield* previewHostSkillLock(refresh.manifest);
  yield* verifyCatalogAt(repo, catalogLock, refresh.manifest, options.onEvent, false, projectedLock.snapshot);
  const paths = [".skill-lock.json", "skills.manifest.json", ...Object.values(manifest.skills).map((skill) => skill.path)];
  const status = yield* runGit(repo, ["status", "--porcelain", "--", ...paths]);
  const dirty = status.stdout.trim().length > 0 || refresh.refreshed.length > 0 || projectedLock.changed;
  if (dirty) {
    for (const name of refresh.refreshed) yield* message(options.onEvent, `would refresh manifest hash for ${name}`);
    yield* message(options.onEvent, "would verify and save catalog-managed changes");
  } else yield* message(options.onEvent, "catalog already saved; nothing to commit");
  return dirty;
});

interface LocalRetirement {
  readonly previous: Manifest;
  readonly state: State;
  readonly removed: ReadonlyArray<string>;
  readonly oldLockEntries: Readonly<Record<string, SkillLockEntry>>;
  readonly plan: Plan;
}

const prepareLocalRetirement = Effect.fn("Convergence.prepareLocalRetirement")(function* (manifest: Manifest, options: PullOptions) {
  const { repo } = yield* HostRepo;
  const store = yield* ManifestStore;
  const previous = yield* loadCommittedManifest(repo);
  const removed = Object.keys(previous.skills).filter((name) => !Object.hasOwn(manifest.skills, name));
  if (removed.length === 0) {
    const previousState = yield* store.loadState(previous);
    const retiresActiveProfile = previousState.selection.kind === "profile" && !Object.hasOwn(manifest.profiles, previousState.selection.name);
    if (!retiresActiveProfile) return undefined;
  }
  const state = yield* store.loadStateForTransition(manifest, previous);
  const linked = state.projectLinks.filter((link) => removed.includes(link.skill));
  if (linked.length > 0) {
    const commands = linked.map((link) => `slinky unlink ${link.skill} ${link.project}`).join("; ");
    return yield* bail(`catalog changes remove linked skills; unlink them before saving: ${commands}`);
  }
  const hostLock = yield* loadHostSkillLock();
  const plan = yield* prepareRetirement(previous, state, removed, options);
  return { previous, state, removed, oldLockEntries: hostLock.entries, plan } satisfies LocalRetirement;
});

const applyLocalRetirement = Effect.fn("Convergence.applyLocalRetirement")(function* (manifest: Manifest, retirement: LocalRetirement, options: PullOptions) {
  const store = yield* ManifestStore;
  yield* applyRetirement(retirement.previous, retirement.oldLockEntries, retirement.removed, retirement.plan, options);
  yield* store.saveState(alignStateWithManifest(manifest, retirement.state));
});

interface FileSnapshot {
  readonly path: string;
  readonly contents?: Buffer;
}

type RetiredPathSnapshot =
  | { readonly path: string; readonly kind: "missing" }
  | { readonly path: string; readonly kind: "symlink"; readonly target: string }
  | { readonly path: string; readonly kind: "copy"; readonly backup: string };

interface LocalSaveSnapshot {
  readonly repo: string;
  readonly before: string;
  readonly indexPath: string;
  readonly indexBackup: string;
  readonly directory: string;
  readonly files: ReadonlyArray<FileSnapshot>;
  readonly globalLock: SkillLockSnapshot;
  readonly retiredPaths: ReadonlyArray<RetiredPathSnapshot>;
}

function snapshotFile(path: string): FileSnapshot {
  try {
    return { path, contents: readFileSync(path) };
  } catch (error) {
    if (isMissingFile(error)) return { path };
    throw error;
  }
}

function restoreFile(snapshot: FileSnapshot): void {
  if (snapshot.contents === undefined) {
    rmSync(snapshot.path, { force: true });
    return;
  }
  mkdirSync(dirname(snapshot.path), { recursive: true });
  const temporary = `${snapshot.path}.slinky-restore-${process.pid}`;
  writeFileSync(temporary, snapshot.contents);
  renameSync(temporary, snapshot.path);
}

function snapshotRetiredPath(path: string, backup: string): RetiredPathSnapshot {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isMissingFile(error)) return { path, kind: "missing" };
    throw error;
  }
  if (stat.isSymbolicLink()) return { path, kind: "symlink", target: readlinkSync(path) };
  cpSync(path, backup, { recursive: stat.isDirectory(), preserveTimestamps: true });
  return { path, kind: "copy", backup };
}

function restoreRetiredPath(snapshot: RetiredPathSnapshot): void {
  try {
    lstatSync(snapshot.path);
    throw new OperationFailed({ message: `${snapshot.path} changed after retirement; refusing to replace it during compensation` });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (snapshot.kind === "missing") return;
  mkdirSync(dirname(snapshot.path), { recursive: true });
  if (snapshot.kind === "symlink") symlinkSync(snapshot.target, snapshot.path);
  else cpSync(snapshot.backup, snapshot.path, { recursive: lstatSync(snapshot.backup).isDirectory(), preserveTimestamps: true });
}

const snapshotLocalSave = Effect.fn("Convergence.snapshotLocalSave")(function* (retirement: LocalRetirement) {
  const { repo, manifestPath, catalogLock, statePath } = yield* HostRepo;
  const paths = yield* Paths;
  const before = (yield* runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const index = yield* runGit(repo, ["rev-parse", "--git-path", "index"]);
  const indexPath = resolve(repo, index.stdout.trim());
  const directory = mkdtempSync(join(tmpdir(), "slinky-save-"));
  return yield* Effect.try({
    try: () => {
      const indexBackup = join(directory, "index");
      copyFileSync(indexPath, indexBackup);
      const retiredPaths = retirement.plan.actions.flatMap((action, index) => {
        if (action.type !== "remove-agents" && action.type !== "remove-claude") return [];
        const base = action.type === "remove-agents" ? paths.agentsSkills : paths.claudeSkills;
        return [snapshotRetiredPath(join(base, action.skill), join(directory, `retired-${index}`))];
      });
      return {
        repo,
        before,
        indexPath,
        indexBackup,
        directory,
        files: [snapshotFile(manifestPath), snapshotFile(catalogLock), snapshotFile(statePath)],
        globalLock: readSkillLockFile(paths.skillLock),
        retiredPaths,
      } satisfies LocalSaveSnapshot;
    },
    catch: (error) => {
      rmSync(directory, { recursive: true, force: true });
      return new OperationFailed({ message: `could not snapshot local retirement: ${errorDetail(error)}` });
    },
  });
});

const restoreLocalSave = Effect.fn("Convergence.restoreLocalSave")(function* (snapshot: LocalSaveSnapshot) {
  const failures: string[] = [];
  const head = yield* Effect.exit(
    Effect.gen(function* () {
      const current = (yield* runGit(snapshot.repo, ["rev-parse", "HEAD"])).stdout.trim();
      if (current !== snapshot.before) yield* runGit(snapshot.repo, ["update-ref", "HEAD", snapshot.before, current]);
    }),
  );
  if (Exit.isFailure(head)) failures.push(`Git HEAD: ${errorDetail(Cause.squash(head.cause))}`);

  const restore = join(snapshot.directory, "index-restore");
  const index = yield* Effect.exit(
    Effect.try({
      try: () => {
        copyFileSync(snapshot.indexBackup, restore);
        renameSync(restore, snapshot.indexPath);
      },
      catch: (error) => new OperationFailed({ message: errorDetail(error) }),
    }),
  );
  if (Exit.isFailure(index)) failures.push(`Git index: ${errorDetail(Cause.squash(index.cause))}`);

  for (const file of snapshot.files) {
    const restored = yield* Effect.exit(Effect.try({ try: () => restoreFile(file), catch: (error) => new OperationFailed({ message: errorDetail(error) }) }));
    if (Exit.isFailure(restored)) failures.push(`${file.path}: ${errorDetail(Cause.squash(restored.cause))}`);
  }
  for (const path of snapshot.retiredPaths) {
    const restored = yield* Effect.exit(Effect.try({ try: () => restoreRetiredPath(path), catch: (error) => new OperationFailed({ message: errorDetail(error) }) }));
    if (Exit.isFailure(restored)) failures.push(`${path.path}: ${errorDetail(Cause.squash(restored.cause))}`);
  }
  const globalLock = yield* Effect.exit(restoreGlobalSkillLock(snapshot.globalLock));
  if (Exit.isFailure(globalLock)) failures.push(`machine lock: ${errorDetail(Cause.squash(globalLock.cause))}`);
  if (failures.length > 0) return yield* bail(`could not fully restore local retirement: ${failures.join("; ")}`);
});

const cleanupLocalSaveSnapshot = Effect.fn("Convergence.cleanupLocalSaveSnapshot")(function* (snapshot: LocalSaveSnapshot, sink: ConvergenceEventSink | undefined) {
  const cleaned = yield* Effect.exit(
    Effect.try({
      try: () => rmSync(snapshot.directory, { recursive: true, force: true }),
      catch: (error) => new OperationFailed({ message: errorDetail(error) }),
    }),
  );
  if (Exit.isFailure(cleaned)) yield* message(sink, `warn: could not remove transaction snapshot ${snapshot.directory}: ${errorDetail(Cause.squash(cleaned.cause))}`, "warning");
});

const saveWithLocalRetirement = Effect.fn("Convergence.saveWithLocalRetirement")(function* (
  manifest: Manifest,
  retirement: LocalRetirement | undefined,
  options: PullOptions & SaveCatalogOptions,
) {
  if (!retirement) return yield* saveCatalogInternal(options);
  const snapshot = yield* snapshotLocalSave(retirement);
  const saved = yield* Effect.exit(
    Effect.gen(function* () {
      yield* applyLocalRetirement(manifest, retirement, options);
      return yield* saveCatalogInternal(options);
    }),
  );
  if (Exit.isFailure(saved)) {
    const restored = yield* Effect.exit(restoreLocalSave(snapshot));
    yield* cleanupLocalSaveSnapshot(snapshot, options.onEvent);
    if (Exit.isFailure(restored)) {
      return yield* Effect.fail(
        new OperationFailed({
          message: `${errorDetail(Cause.squash(saved.cause))}; compensation also failed: ${errorDetail(Cause.squash(restored.cause))}`,
        }),
      );
    }
    return yield* Effect.failCause(saved.cause);
  }
  yield* cleanupLocalSaveSnapshot(snapshot, options.onEvent);
  return saved.value;
});

export const saveCatalog = Effect.fn("Convergence.saveCatalog")(function* (options: SaveCatalogOptions = {}) {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const { repo } = yield* HostRepo;
  yield* assertGitRoot(repo);
  const retirementOptions = { ...options, restoreDrift: false } satisfies PullOptions & SaveCatalogOptions;
  const retirement = yield* prepareLocalRetirement(manifest, retirementOptions);
  return yield* saveWithLocalRetirement(manifest, retirement, retirementOptions);
});

const restoreAllVendorDrift = Effect.fn("Convergence.restoreAllVendorDrift")(function* (manifest: Manifest, dryRun: boolean, sink: ConvergenceEventSink | undefined) {
  const targets = yield* findDriftingVendors(manifest);
  if (targets.length === 0) {
    yield* message(sink, "all live vendor skills already match the catalog");
    return targets;
  }
  for (const name of targets) {
    if (dryRun) yield* message(sink, `would restore ${name} live copy from repo baseline`);
    else {
      yield* vendorRestore(manifest, name);
      yield* message(sink, `${name}: live copy restored from repo baseline`);
    }
  }
  return targets;
});

export const syncCatalog = Effect.fn("Convergence.syncCatalog")(function* (options: SyncCatalogOptions = {}) {
  const git = yield* inspectSyncGit();
  if (options.dryRun) {
    yield* section(options.onEvent, "save", false);
    const store = yield* ManifestStore;
    const manifest = yield* store.loadManifest();
    const retirementOptions = { ...options, restoreDrift: true };
    const retirement = git.isGitRoot ? yield* prepareLocalRetirement(manifest, retirementOptions) : undefined;
    const state = retirement ? alignStateWithManifest(manifest, retirement.state) : yield* store.loadState(manifest);
    let projected = { manifest, state };
    const savePending = git.isGitRoot ? yield* previewCatalogSave(manifest, options) : false;
    if (!git.isGitRoot) yield* message(options.onEvent, "not a Git repository; save and pull skipped", "dim");
    yield* section(options.onEvent, "pull", true);
    if (!git.hasUpstream) yield* message(options.onEvent, "no configured upstream; pull skipped", "dim");
    else if (savePending) yield* message(options.onEvent, "would pull after saving catalog changes; run dry-run again after saving for remote details");
    else projected = yield* pullCatalogInternal(retirementOptions);
    yield* section(options.onEvent, "reconcile", true);
    yield* renderReconciliation(projected.manifest, projected.state, options);
    yield* section(options.onEvent, "restore", true);
    const restored = yield* restoreAllVendorDrift(projected.manifest, true, options.onEvent);
    if (restored.length > 0) yield* message(options.onEvent, "would reconcile global stores again after restoring vendor drift");
    return { restored } satisfies SyncCatalogReport;
  }

  if (git.isGitRoot) {
    yield* section(options.onEvent, "save", false);
    const store = yield* ManifestStore;
    const manifest = yield* store.loadManifest();
    const retirementOptions = { ...options, restoreDrift: true };
    const retirement = yield* prepareLocalRetirement(manifest, retirementOptions);
    yield* saveWithLocalRetirement(manifest, retirement, retirementOptions);
  } else yield* message(options.onEvent, "save: not a Git repository; skipped", "dim");

  if (git.hasUpstream) {
    yield* section(options.onEvent, "pull", true);
    yield* pullCatalogInternal({ ...options, restoreDrift: true });
  } else {
    yield* message(options.onEvent, "pull: no configured upstream; skipped", "dim");
    const { manifest, state } = yield* loadHostState;
    yield* section(options.onEvent, "reconcile", true);
    yield* renderReconciliation(manifest, state, options);
  }

  yield* section(options.onEvent, "restore", true);
  const { manifest, state } = yield* loadHostState;
  const restored = yield* restoreAllVendorDrift(manifest, false, options.onEvent);
  if (restored.length > 0) {
    yield* section(options.onEvent, "finalize", true);
    yield* renderReconciliation(manifest, state, options);
  }
  return { restored } satisfies SyncCatalogReport;
});

export const pushCatalog = Effect.fn("Convergence.pushCatalog")(function* (options: PushCatalogOptions = {}) {
  const { repo } = yield* HostRepo;
  yield* loadHostState;
  yield* assertGitRoot(repo);
  yield* requireCleanWorktree(repo);
  const { upstream, remote, mergeRef } = yield* requireUpstream(repo);
  const headCommit = (yield* runGit(repo, ["rev-parse", "HEAD^{commit}"])).stdout.trim();
  yield* loadIncomingCatalog(repo, headCommit, options.onEvent);
  const hostLock = yield* loadHostSkillLock();
  if (!hostLock.exists) return yield* bail(".skill-lock.json is missing; run `slinky save` before pushing");
  const args = options.dryRun ? ["push", "--dry-run", remote, `${headCommit}:${mergeRef}`] : ["push", remote, `${headCommit}:${mergeRef}`];
  yield* emitGitOutput(options.onEvent, yield* runGit(repo, args));
  yield* message(options.onEvent, options.dryRun ? `push to ${upstream} would succeed` : `pushed catalog to ${upstream}`);
  return { upstream, dryRun: options.dryRun ?? false } satisfies PushCatalogReport;
});
