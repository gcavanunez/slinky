#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import packageJson from "../package.json" with { type: "json" };
import { errorDetail, ExternalToolError, OperationFailed } from "./domain/model.ts";
import { adoptSkill, backfillTreeHash, clearStagingResidue, finalizeAdoption, findForeign, findStaged, findUnindexedSkills, rollbackAdoption } from "./lib/adopt.ts";
import type { Adoption, AdoptOptions, ForeignSkill } from "./lib/adopt.ts";
import { backupGlobalDirs } from "./lib/bootstrap.ts";
import { applyProfile, linkProjectSkill, setSkillsEnabled, unlinkProjectSkill } from "./lib/catalogActions.ts";
import type { ActionResult } from "./lib/catalogActions.ts";
import { contentHash, findSymlinks, walkFiles } from "./lib/hash.ts";
import { diffDirs, isClean, pagePatch, unifiedDiff } from "./lib/diff.ts";
import type { DiffPager } from "./lib/diff.ts";
import { parseCommand } from "./lib/editor.ts";
import { layerRepo } from "./lib/layers.ts";
import { checkLink } from "./lib/linker.ts";
import { alignStateWithManifest, getSkill, isSkillEnabled, Manifest, ManifestStore, withSkillEnabled } from "./lib/manifest.ts";
import type { ManifestStoreInterface, State } from "./lib/manifest.ts";
import { HostRepo, isRepoDir, Paths, RepoNotFoundError, RepoResolution } from "./lib/paths.ts";
import { apply, observe, observeAndPlan, planSync } from "./lib/reconcile.ts";
import type { Plan } from "./lib/reconcile.ts";
import { refreshLocalHashes } from "./lib/rehash.ts";
import {
  absorbGlobalSkillLockEntries,
  ensureHostSkillLock,
  loadHostSkillLock,
  loadSkillLockFile,
  pruneGlobalSkillLockEntries,
  readSkillLockFile,
  restoreHostSkillLock,
  saveHostSkillLock,
  seedGlobalSkillLock,
  skillLockVersion,
  validateSkillLock,
} from "./lib/skillLock.ts";
import type { SkillLockEntry } from "./lib/skillLock.ts";
import { vendorAccept, vendorRestore } from "./lib/vendorOps.ts";
import { baselineDirty, checkUpstream, detectChanges, runSkillsAdd, runSkillsUpdate } from "./lib/update.ts";
import type { GitHub } from "./lib/update.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function resolveDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex -- ANSI escape sequences begin with this control character.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Expected usage/domain failure surfaced as `error: <message>` with exit 1. */
const bail = (message: string) => Effect.fail(new OperationFailed({ message }));

type RepoServices = ManifestStore | GitHub | HostRepo;

/** Run a repo-scoped effect; repo discovery failures become typed errors. */
const withRepo = <A, E>(effect: Effect.Effect<A, E, RepoServices | Paths>) => Effect.provide(effect, layerRepo);

/** Load the manifest and its aligned state along with the store handle. */
const loadHostState = Effect.gen(function* () {
  const store = yield* ManifestStore;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  return { store, manifest, state };
});

interface SyncOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

const runSyncCmd = Effect.fn("Cli.runSync")(function* (manifest: Manifest, state: State, options: SyncOptions) {
  const plan = yield* observeAndPlan(manifest, state, { force: options.force ?? false });
  for (const w of plan.warnings) console.log(c.yellow(`warn: ${w}`));
  if (options.dryRun) {
    if (plan.actions.length === 0) console.log("nothing to do");
    for (const a of plan.actions) console.log(`would ${a.type} ${a.skill}`);
    return;
  }
  const res = yield* apply(plan, { force: options.force ?? false });
  for (const d of res.done) console.log(`  ${d}`);
  for (const s of res.skipped) console.log(c.yellow(`  skipped: ${s}`));
  if (res.done.length === 0 && res.skipped.length === 0) console.log("in sync; nothing to do");
});

const seedVerifiedGlobalProvenance = Effect.fn("Cli.seedVerifiedGlobalProvenance")(function* (manifest: Manifest) {
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

function renderAction(result: ActionResult): void {
  for (const warning of result.warnings) console.log(c.yellow(`warn: ${warning}`));
  if (result.dryRun) {
    if (result.messages.length === 0) console.log("nothing to do");
    for (const message of result.messages) console.log(`would ${message}`);
    return;
  }
  for (const message of result.messages) console.log(`  ${message}`);
  if (result.messages.length === 0 && result.warnings.length === 0) {
    console.log("in sync; nothing to do");
  }
}

const cmdStatus = Effect.fn("Cli.status")(function* (manifest: Manifest, state: State) {
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;
  const obs = yield* observe();
  const nameW = Math.max(4, ...Object.keys(manifest.skills).map((n) => n.length)) + 2;
  console.log(c.dim(`host: ${repo}\n`));
  console.log(c.bold(`${pad("NAME", nameW)}${pad("ORIGIN", 8)}${pad("ENABLED", 9)}${pad("LIVE", 10)}CLAUDE`));
  for (const [name, meta] of Object.entries(manifest.skills)) {
    const enabled = isSkillEnabled(state, name);
    const live = Object.hasOwn(obs.agents, name) ? obs.agents[name]! : { kind: "missing" as const };
    const claude = Object.hasOwn(obs.claude, name) ? "yes" : c.dim("-");

    let liveLabel: string;
    if (!enabled) {
      liveLabel = live.kind === "missing" ? c.dim("-") : c.yellow(live.kind);
    } else if (meta.origin === "local") {
      liveLabel = live.kind === "symlink" ? c.green("ok") : c.red(live.kind);
    } else if (live.kind === "dir") {
      liveLabel = contentHash(join(paths.agentsSkills, name)) === meta.contentHash ? c.green("ok") : c.yellow("drift");
    } else {
      liveLabel = c.red(live.kind);
    }

    console.log(
      `${pad(name, nameW)}${pad(meta.origin, 8)}${pad(enabled ? "on" : c.dim("off"), enabled ? 9 : 9 + 9)}${pad(liveLabel, 10 + liveLabel.length - stripAnsi(liveLabel).length)}${claude}`,
    );
  }
  const foreign = Object.keys(obs.agents).filter((n) => !(n in manifest.skills));
  if (foreign.length > 0) console.log(c.yellow(`\nforeign entries in ~/.agents/skills: ${foreign.join(", ")}`));
  const unindexed = findUnindexedSkills(manifest, repo);
  if (unindexed.length > 0) {
    console.log(c.yellow("\nunindexed skills in host:"));
    for (const skill of unindexed) console.log(`  ${pad(skill.name, nameW)}${skill.path}`);
  }
});

const renderPatch = Effect.fn("Cli.renderPatch")(function* (baseline: string, live: string) {
  return yield* Effect.try({
    try: () => unifiedDiff(baseline, live),
    catch: (error) => new ExternalToolError({ tool: "diff", message: errorDetail(error) }),
  });
});

const openPager = Effect.fn("Cli.openPager")(function* (patch: string, pager: DiffPager) {
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
const selectPager = Effect.fn("Cli.selectPager")(function* (choice: PagerChoice) {
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

interface DiffOptions {
  readonly patch: boolean;
  readonly pager?: DiffPager;
}

const cmdDiff = Effect.fn("Cli.diff")(function* (manifest: Manifest, names: ReadonlyArray<string>, options: DiffOptions) {
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;
  const pager = options.pager;
  const patches: string[] = [];
  const targets =
    names.length > 0
      ? names
      : Object.entries(manifest.skills)
          .filter(([, m]) => m.origin === "vendor")
          .map(([n]) => n);
  let dirty = 0;
  for (const name of targets) {
    const meta = getSkill(manifest, name);
    if (!meta) return yield* bail(`unknown skill: ${name}`);
    const repoPath = join(repo, meta.path);
    const live = join(paths.agentsSkills, name);
    if (meta.origin === "local") {
      console.log(`${name}: ${c.dim("local skill (symlinked; nothing to diff)")}`);
      continue;
    }
    if (!existsSync(live)) {
      console.log(`${name}: ${c.dim("not installed globally (disabled?)")}`);
      continue;
    }
    const d = diffDirs(repoPath, live);
    if (isClean(d)) {
      if (names.length > 0) console.log(`${name}: ${c.green("in sync")}`);
      continue;
    }
    dirty++;
    const rendered = options.patch || pager ? yield* renderPatch(repoPath, live) : "";
    if (pager) {
      patches.push(rendered);
    } else {
      console.log(c.bold(`${name}: ${c.yellow("differs from repo baseline")}`));
      for (const f of d.added) console.log(c.green(`  + ${f}`));
      for (const f of d.removed) console.log(c.red(`  - ${f}`));
      for (const f of d.modified) console.log(c.yellow(`  ~ ${f}`));
      if (options.patch) console.log(rendered);
    }
  }
  if (pager && patches.length > 0) {
    yield* openPager(patches.join("\n"), pager);
  } else if (names.length === 0) {
    console.log(dirty === 0 ? c.green("\nall vendored skills in sync") : c.yellow(`\n${dirty} skill(s) differ`));
  }
});

const verifyCatalogAt = Effect.fn("Cli.verifyCatalogAt")(function* (repo: string, catalogLock: string, manifest: Manifest, requireLock = false) {
  let bad = 0;
  for (const [name, meta] of Object.entries(manifest.skills)) {
    const repoPath = join(repo, meta.path);
    if (!existsSync(repoPath)) {
      console.log(c.red(`${name}: repo copy missing at ${meta.path}`));
      bad++;
      continue;
    }
    const stat = lstatSync(repoPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      console.log(c.red(`${name}: repo path must be a real directory: ${meta.path}`));
      bad++;
      continue;
    }
    const symlinks = findSymlinks(repoPath);
    if (symlinks.length > 0) {
      console.log(c.red(`${name}: repo copy contains symlink(s): ${symlinks.join(", ")}`));
      bad++;
      continue;
    }
    const h = contentHash(repoPath);
    if (h !== meta.contentHash) {
      console.log(c.yellow(`${name}: repo copy hash mismatch (manifest stale?)`));
      bad++;
    }
  }
  const lock = yield* loadSkillLockFile(catalogLock);
  if (requireLock && !lock.exists) {
    console.log(c.yellow(".skill-lock.json is missing; run `slinky save` to create and commit it"));
    bad++;
  }
  for (const issue of validateSkillLock(manifest, lock)) {
    console.log(c.yellow(issue));
    bad++;
  }
  if (bad > 0) return yield* bail(`${bad} catalog verification problem(s)`);
  console.log(c.green(`all ${Object.keys(manifest.skills).length} skills verified`));
});

const cmdVerify = Effect.fn("Cli.verify")(function* (manifest: Manifest) {
  const { repo, catalogLock } = yield* HostRepo;
  yield* verifyCatalogAt(repo, catalogLock, manifest);
});

/** Run git without inheriting the caller's repository environment, reporting the exit status. */
const tryGit = Effect.fn("Cli.tryGit")(function* (repo: string, args: ReadonlyArray<string>) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"]) {
    delete env[name];
  }
  const result = yield* Effect.sync(() => spawnSync("git", ["--literal-pathspecs", ...args], { cwd: repo, encoding: "utf8", env }));
  if (result.error) {
    return yield* Effect.fail(new ExternalToolError({ tool: "git", message: result.error.message }));
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
});

const runGit = Effect.fn("Cli.runGit")(function* (repo: string, args: ReadonlyArray<string>) {
  const result = yield* tryGit(repo, args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return yield* Effect.fail(new ExternalToolError({ tool: "git", message: detail || `git exited with ${result.status ?? "unknown"}` }));
  }
  return { stdout: result.stdout, stderr: result.stderr };
});

const assertGitRoot = Effect.fn("Cli.assertGitRoot")(function* (repo: string) {
  const topLevel = yield* runGit(repo, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(topLevel.stdout.trim()) !== realpathSync(repo)) {
    return yield* bail(`skills host must be a Git repository root: ${repo}`);
  }
});

const requireCleanWorktree = Effect.fn("Cli.requireCleanWorktree")(function* (repo: string) {
  const status = yield* runGit(repo, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.stdout.trim()) return yield* bail("skills host worktree must be clean; save, commit, or remove local changes first");
});

const requireUpstream = Effect.fn("Cli.requireUpstream")(function* (repo: string) {
  const branch = (yield* runGit(repo, ["branch", "--show-current"])).stdout.trim();
  if (!branch) return yield* bail("skills host is on a detached HEAD; check out a branch first");
  const upstream = yield* runGit(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.mapError(() => new OperationFailed({ message: `branch ${branch} has no upstream; configure one with git push --set-upstream` })),
  );
  const remote = (yield* runGit(repo, ["config", "--get", `branch.${branch}.remote`])).stdout.trim();
  const mergeRef = (yield* runGit(repo, ["config", "--get", `branch.${branch}.merge`])).stdout.trim();
  return { branch, upstream, remote, mergeRef };
});

function renderGitOutput(result: { readonly stdout: string; readonly stderr: string }): void {
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output) console.log(output);
}

interface PullOptions extends SyncOptions {
  readonly dryRun?: boolean;
}

const prepareRetirement = Effect.fn("Cli.prepareRetirement")(function* (manifest: Manifest, state: State, removed: ReadonlyArray<string>, options: PullOptions) {
  if (removed.length === 0) return { actions: [], warnings: [] } satisfies Plan;
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;
  const observation = yield* observe();
  const removalState = removed.reduce((current, name) => withSkillEnabled(current, name, false), state);
  const fullPlan = planSync(manifest, removalState, observation, { repo, claudeSkills: paths.claudeSkills, force: options.force ?? false });
  const names = new Set(removed);
  const retirementRank = (action: Plan["actions"][number]): number => (action.type === "remove-agents" ? 0 : action.type === "remove-claude" ? 1 : 2);
  const plan = {
    actions: fullPlan.actions
      .filter((action) => names.has(action.skill))
      .map((action) => {
        if (action.type === "remove-agents") {
          const live = observation.agents[action.skill];
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
    if (live?.kind === "dir" && contentHash(join(paths.agentsSkills, name)) !== meta.contentHash && !options.force) {
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
  if (options.dryRun) {
    for (const action of plan.actions) console.log(`would ${action.type} retired skill ${action.skill}`);
  }
  return plan;
});

const applyRetirement = Effect.fn("Cli.applyRetirement")(function* (
  manifest: Manifest,
  oldLockEntries: Readonly<Record<string, SkillLockEntry>>,
  removed: ReadonlyArray<string>,
  plan: Plan,
  options: PullOptions,
) {
  const result = yield* apply(plan, { force: options.force ?? false });
  for (const done of result.done) console.log(`  ${done}`);
  if (result.skipped.length > 0) {
    return yield* bail(`retired skill cleanup changed after preflight: ${result.skipped.join("; ")}`);
  }
  yield* pruneGlobalSkillLockEntries(manifest, oldLockEntries, removed, options.force ?? false);
});

const loadIncomingCatalog = Effect.fn("Cli.loadIncomingCatalog")(function* (repo: string, upstream: string) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const checkout = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const directory = mkdtempSync(join(tmpdir(), "slinky-pull-"));
          yield* runGit(repo, ["worktree", "add", "--detach", directory, upstream]).pipe(
            Effect.onError(() => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))),
          );
          return directory;
        }),
        (directory) =>
          Effect.gen(function* () {
            yield* runGit(repo, ["worktree", "remove", "--force", directory]).pipe(Effect.ignore);
            yield* Effect.sync(() => rmSync(directory, { recursive: true, force: true }));
          }),
      );
      const manifest = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(join(checkout, "skills.manifest.json"), "utf8")), { errors: "all", onExcessProperty: "error" }),
        catch: (error) => new OperationFailed({ message: `incoming skills.manifest.json is invalid: ${errorDetail(error)}` }),
      });
      yield* verifyCatalogAt(checkout, join(checkout, ".skill-lock.json"), manifest, true);
      return manifest;
    }),
  );
});

/** Paths git reports as conflicted in `merge-tree --write-tree` output, which follows the tree OID. */
function conflictedPaths(mergeTreeStdout: string): ReadonlyArray<string> {
  const lines = mergeTreeStdout.split("\n").slice(1);
  const end = lines.indexOf("");
  const entries = end === -1 ? lines : lines.slice(0, end);
  return [...new Set(entries.map((line) => line.split("\t")[1]).filter((path): path is string => path !== undefined))];
}

/**
 * Reconcile a diverged branch by replaying local commits onto the upstream tip.
 *
 * Two machines both running `slinky save` is the ordinary way this catalog diverges, and the
 * resulting commits almost always touch disjoint skills, so pull rebases them itself rather than
 * stopping. It only does so when it can prove the outcome first: `merge-tree` has to merge without
 * conflict, and the merged catalog must not retire any skill. Retirement needs the preflight the
 * fast-forward path runs below (global drift guards, project-link blocking, lock pruning), and a
 * rebase leaves nothing behind for it to act on, so those cases are handed back instead of being
 * silently skipped.
 */
const rebaseDivergence = Effect.fn("Cli.rebaseDivergence")(function* (
  repo: string,
  upstream: string,
  upstreamCommit: string,
  manifest: Manifest,
  ahead: number,
  options: PullOptions,
) {
  const manually = `resolve them with Git before pulling: git rebase ${upstream}`;
  const merge = yield* tryGit(repo, ["merge-tree", "--write-tree", upstreamCommit, "HEAD"]);
  if (merge.status !== 0) {
    const paths = conflictedPaths(merge.stdout);
    const detail = paths.length > 0 ? ` (conflicts in ${paths.join(", ")})` : "";
    return yield* bail(`local branch and ${upstream} have diverged and do not merge cleanly${detail}; ${manually}`);
  }
  const tree = merge.stdout.split("\n")[0]?.trim();
  if (!tree) return yield* bail(`could not compute a merge of HEAD and ${upstream}; ${manually}`);

  const mergedFile = yield* runGit(repo, ["cat-file", "-p", `${tree}:skills.manifest.json`]);
  const merged = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Manifest)(JSON.parse(mergedFile.stdout)),
    catch: (error) => new OperationFailed({ message: `merged skills.manifest.json is invalid: ${errorDetail(error)}` }),
  });
  const retired = Object.keys(manifest.skills).filter((name) => !Object.hasOwn(merged.skills, name));
  if (retired.length > 0) {
    return yield* bail(`local branch and ${upstream} have diverged and the merge retires ${retired.join(", ")}; ${manually}`);
  }

  if (options.dryRun) {
    console.log(`would replay ${ahead} local commit(s) onto ${upstream}`);
    return;
  }
  const before = (yield* runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
  console.log(`diverged from ${upstream}; replaying ${ahead} local commit(s) onto it`);
  // merge-tree proves the combined result is clean, not that each commit replays cleanly, so an
  // interrupted rebase is still possible; abort it so the branch is left exactly as it was found.
  const rebase = yield* tryGit(repo, ["rebase", upstreamCommit]);
  if (rebase.status !== 0) {
    yield* tryGit(repo, ["rebase", "--abort"]).pipe(Effect.ignore);
    return yield* bail(`could not replay local commits onto ${upstream}; branch left at ${before.slice(0, 7)}; ${manually}`);
  }
  console.log(`replayed ${ahead} commit(s); previous branch tip was ${before.slice(0, 7)}`);
});

const pullAndSync = Effect.fn("Cli.pullAndSync")(function* (options: PullOptions) {
  const { repo } = yield* HostRepo;
  const { store, manifest: loadedManifest, state: loadedState } = yield* loadHostState;
  let currentManifest = loadedManifest;
  let currentState = loadedState;
  const paths = yield* Paths;
  yield* assertGitRoot(repo);
  yield* requireCleanWorktree(repo);
  yield* cmdVerify(currentManifest);
  let currentHostLock = yield* loadHostSkillLock();
  if (!currentHostLock.exists) return yield* bail(".skill-lock.json is missing; run `slinky save` before pulling");
  const globalLock = readSkillLockFile(paths.skillLock);
  if (globalLock.warning) return yield* Effect.fail(globalLock.warning);
  if (globalLock.exists && globalLock.version !== skillLockVersion) {
    return yield* bail(`machine skill lock version ${globalLock.version} is not supported for writes`);
  }
  const { upstream, remote, mergeRef } = yield* requireUpstream(repo);
  renderGitOutput(yield* runGit(repo, ["fetch", remote, mergeRef]));
  const upstreamCommit = (yield* runGit(repo, ["rev-parse", "FETCH_HEAD^{commit}"])).stdout.trim();

  const countAgainstUpstream = Effect.fn("Cli.countAgainstUpstream")(function* () {
    const counts = (yield* runGit(repo, ["rev-list", "--left-right", "--count", `HEAD...${upstreamCommit}`])).stdout.trim().split(/\s+/);
    const ahead = Number.parseInt(counts[0] ?? "", 10);
    const behind = Number.parseInt(counts[1] ?? "", 10);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return yield* bail(`could not compare HEAD with ${upstream}`);
    return { ahead, behind };
  });

  let { ahead, behind } = yield* countAgainstUpstream();
  if (ahead > 0 && behind > 0) {
    yield* rebaseDivergence(repo, upstream, upstreamCommit, currentManifest, ahead, options);
    if (options.dryRun) return;
    // The rebase rewrote the catalog under us; re-read it and re-verify before anything acts on it.
    currentManifest = yield* store.loadManifest();
    currentState = alignStateWithManifest(currentManifest, currentState);
    currentHostLock = yield* loadHostSkillLock();
    yield* cmdVerify(currentManifest);
    ({ ahead, behind } = yield* countAgainstUpstream());
  }

  if (behind === 0) {
    console.log(ahead > 0 ? `already up to date from ${upstream}; local branch is ${ahead} commit(s) ahead` : `already up to date with ${upstream}`);
    if (options.dryRun) return;
    yield* store.saveState(currentState);
    yield* runSyncCmd(currentManifest, currentState, options);
    yield* seedVerifiedGlobalProvenance(currentManifest);
    return;
  }

  const incomingManifest = yield* loadIncomingCatalog(repo, upstreamCommit);
  const removed = Object.keys(currentManifest.skills).filter((name) => !Object.hasOwn(incomingManifest.skills, name));
  const linked = currentState.projectLinks.filter((link) => removed.includes(link.skill));
  if (linked.length > 0) {
    const commands = linked.map((link) => `slinky unlink ${link.skill} ${link.project}`).join("; ");
    return yield* bail(`incoming catalog removes linked skills; unlink them before pulling: ${commands}`);
  }

  console.log(options.dryRun ? `would fast-forward ${behind} commit(s) from ${upstream}` : `fast-forwarding ${behind} commit(s) from ${upstream}`);
  const retirement = yield* prepareRetirement(currentManifest, currentState, removed, options);
  if (options.dryRun) return;

  renderGitOutput(yield* runGit(repo, ["merge", "--ff-only", upstreamCommit]));
  const manifest = yield* store.loadManifest();
  const state = alignStateWithManifest(manifest, currentState);
  yield* applyRetirement(currentManifest, currentHostLock.entries, removed, retirement, options);
  yield* store.saveState(state);
  yield* runSyncCmd(manifest, state, options);
  yield* seedVerifiedGlobalProvenance(manifest);
});

/**
 * Adopt candidates, persist manifest + state, and finalize. On failure the
 * manifest is restored and (when the restore was truthful) the copied
 * destinations are rolled back.
 */
const adoptCandidates = Effect.fn("Cli.adoptCandidates")(function* (
  store: ManifestStoreInterface,
  initialManifest: Manifest,
  initialState: State,
  picked: ReadonlyArray<ForeignSkill>,
  options: AdoptOptions,
) {
  const previousManifest = initialManifest;
  const previousLock = yield* loadHostSkillLock();
  const ensuredLock = yield* ensureHostSkillLock(initialManifest);
  let manifest = initialManifest;
  let state = initialState;
  const lockEntries = { ...ensuredLock.entries };
  const adoptions: Adoption[] = [];
  const staged: string[] = [];
  let manifestWritten = false;
  yield* Effect.gen(function* () {
    for (const cand of picked) {
      // A project-scoped lock has no git tree SHA; recover it so the adopted
      // skill still answers to `update --check`.
      const lock = cand.lock ? yield* backfillTreeHash(cand.lock) : undefined;
      const candidate = lock === undefined ? cand : { ...cand, lock };
      const result = yield* adoptSkill(manifest, candidate, options);
      adoptions.push(result);
      if (result.lockEntry) lockEntries[cand.name] = result.lockEntry;
      if (cand.location === "staged") staged.push(cand.name);
      manifest = result.manifest;
      console.log(`adopted ${c.bold(cand.name)} -> ${result.meta.path}`);
    }
    state = alignStateWithManifest(manifest, state);
    yield* store.saveManifest(manifest);
    manifestWritten = true;
    yield* store.saveState(state);
    yield* saveHostSkillLock(lockEntries);
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        let restored = !manifestWritten;
        if (manifestWritten) {
          restored = yield* store.saveManifest(previousManifest).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
        }
        if (restored) for (const adoption of adoptions) rollbackAdoption(adoption);
        yield* restoreHostSkillLock(previousLock).pipe(Effect.ignore);
      }),
    ),
  );
  for (const adoption of adoptions) finalizeAdoption(adoption);
  const warnings: string[] = [];
  for (const name of staged) warnings.push(...(yield* clearStagingResidue(name)));
  return { manifest, state, warnings };
});

/** Where an adoptable skill currently sits, for display. */
const originLabel = (cand: ForeignSkill): string => (cand.location === "staged" ? ".agents/skills" : `~/.${cand.location}`);

interface AdoptPool {
  /** Adoptable now: staged inbox entries first, then host skills not shadowed by one. */
  readonly candidates: ReadonlyArray<ForeignSkill>;
  /** Staged copies identical to a baseline already in the manifest; safe to discard. */
  readonly redundant: ReadonlyArray<{ readonly name: string; readonly path: string; readonly dir: string }>;
  /** Staged copies that moved on from their baseline: an update, not an adoption. */
  readonly changed: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  readonly warnings: ReadonlyArray<string>;
}

/** Merge the repo staging inbox with host skill dirs; a staged copy wins its name. */
const collectAdoptable = Effect.fn("Cli.collectAdoptable")(function* (manifest: Manifest) {
  const stagedScan = yield* findStaged(manifest);
  const foreignScan = yield* findForeign(manifest);
  const warnings: string[] = [];
  if (stagedScan.warning) warnings.push(stagedScan.warning.message);
  if (foreignScan.warning) warnings.push(foreignScan.warning.message);

  const candidates: ForeignSkill[] = [];
  const redundant: Array<{ name: string; path: string; dir: string }> = [];
  const changed: Array<{ name: string; path: string }> = [];
  const stagedNames = new Set<string>();
  for (const { candidate, status } of stagedScan.staged) {
    stagedNames.add(candidate.name);
    if (status.kind === "new") candidates.push(candidate);
    else if (status.kind === "duplicate") redundant.push({ name: candidate.name, path: status.path, dir: candidate.dir });
    else changed.push({ name: candidate.name, path: status.path });
  }
  for (const cand of foreignScan.candidates) {
    if (stagedNames.has(cand.name)) {
      warnings.push(`${cand.name}: staged in the repo and also in ~/.${cand.location}; using the staged copy`);
      continue;
    }
    candidates.push(cand);
  }
  return { candidates, redundant, changed, warnings } satisfies AdoptPool;
});

/** The staging inbox is skills.sh working space, not repo content worth committing. */
const suggestStagingIgnore = Effect.fn("Cli.suggestStagingIgnore")(function* () {
  const { repo, stagedSkills } = yield* HostRepo;
  if (!existsSync(stagedSkills)) return;
  const gitignore = join(repo, ".gitignore");
  const lines = existsSync(gitignore) ? readFileSync(gitignore, "utf8").split(/\r?\n/) : [];
  if (lines.some((line) => line.trim() === ".agents/" || line.trim() === ".agents")) return;
  console.log(c.dim("tip: add `.agents/` to .gitignore so the skills.sh staging inbox stays out of git"));
});

/** Discard staging copies that merely duplicate a baseline already in the manifest. */
const dropRedundantStaging = Effect.fn("Cli.dropRedundantStaging")(function* (pool: AdoptPool) {
  for (const entry of pool.redundant) {
    rmSync(entry.dir, { recursive: true, force: true });
    for (const warning of yield* clearStagingResidue(entry.name)) console.log(c.yellow(`warn: ${warning}`));
    console.log(c.dim(`  ${entry.name}: already indexed at ${entry.path}; removed the redundant staging copy`));
  }
});

// --- shared flags/arguments ----------------------------------------------

const dryRunFlag = Flag.boolean("dry-run").pipe(Flag.withDescription("Print prospective actions without changing anything"));
const forceFlag = Flag.boolean("force").pipe(Flag.withDescription("Override drift and safety guards"));
const pullFlag = Flag.boolean("pull").pipe(Flag.withDescription("Fetch and fast-forward the configured upstream before syncing"));
const skillsArg = Argument.string("skill").pipe(Argument.variadic({ min: 1 }));
const optionalSkillsArg = Argument.string("skill").pipe(Argument.variadic({ min: 0 }));
const pagerFlags = {
  pager: Flag.choice("pager", ["hunk", "delta"] as const).pipe(Flag.optional, Flag.withDescription("Open the patch in hunk or delta")),
  hunk: Flag.boolean("hunk").pipe(Flag.withDescription("Open the patch in Hunk")),
  delta: Flag.boolean("delta").pipe(Flag.withDescription("Open the patch in Delta")),
  noPager: Flag.boolean("no-pager").pipe(Flag.withDescription("Print inline, ignoring the configured diff pager")),
};

// --- commands -------------------------------------------------------------

const tuiCommand = Command.make("tui", {}, () =>
  Effect.gen(function* () {
    // Repo discovery must succeed before handing the terminal to the TUI.
    yield* withRepo(Effect.void);
    yield* Effect.promise(async () => {
      const { runTui } = await import("./tui/index.tsx");
      await runTui();
    });
  }),
).pipe(Command.withDescription("Interactive catalog (default)"));

const initCommand = Command.make(
  "init",
  {
    path: Argument.string("path").pipe(Argument.optional),
  },
  ({ path }) =>
    Effect.gen(function* () {
      const paths = yield* Paths;
      const dir = resolveDir(Option.getOrElse(path, () => process.cwd()));
      if (!isRepoDir(dir)) return yield* bail(`no skills.manifest.json in ${dir}; point init at your skills repo clone`);
      yield* paths.saveHostConfig(dir);
      console.log(`recorded skills repo: ${dir}\n${c.dim(`(${paths.slinkyConfig})`)}`);
    }),
).pipe(Command.withDescription("Record the skills repo clone location (also: $SLINKY_REPO env var overrides)"));

interface BootstrapInput {
  readonly adoptAll: boolean;
  readonly noBackup: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly clone: Option.Option<string>;
  readonly dest: Option.Option<string>;
}

/** Fresh machine: clone the data repo, record it, then re-run bootstrap against it. */
const cloneBootstrap = Effect.fn("Cli.cloneBootstrap")(function* (url: string, input: BootstrapInput) {
  const paths = yield* Paths;
  const name =
    url
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") || "my-agent-skills";
  const dest = resolveDir(Option.getOrElse(input.dest, () => join(paths.home, name)));
  if (isRepoDir(dest)) {
    console.log(c.dim(`${dest} already contains a skills repo; skipping clone`));
  } else {
    console.log(`cloning ${url} -> ${dest}`);
    const res = spawnSync("git", ["clone", url, dest], { stdio: "inherit" });
    if (res.status !== 0) return yield* bail("git clone failed");
  }
  yield* paths.saveHostConfig(dest);

  // Re-exec bootstrap; discovery now resolves via the config file.
  const passthrough = [
    ...(input.adoptAll ? ["--adopt-all"] : []),
    ...(input.noBackup ? ["--no-backup"] : []),
    ...(input.dryRun ? ["--dry-run"] : []),
    ...(input.force ? ["--force"] : []),
  ];
  const compiled = process.argv[1]?.includes("$bunfs") ?? false;
  const argv1 = process.argv[1];
  const rerun = compiled || argv1 === undefined ? [] : [argv1];
  const res = spawnSync(process.execPath, [...rerun, "bootstrap", ...passthrough], {
    stdio: "inherit",
  });
  process.exit(res.status ?? 0);
});

const bootstrapFlow = (input: BootstrapInput) =>
  Effect.gen(function* () {
    const { store, manifest: initialManifest, state: initialState } = yield* loadHostState;
    let manifest = initialManifest;
    let state = initialState;
    const dryRun = input.dryRun;
    console.log(c.bold("bootstrap: adopting this repo as the source of truth\n"));

    // 1. safety net
    if (!input.noBackup && !dryRun) {
      const archive = yield* backupGlobalDirs();
      console.log(archive ? `backup: ${archive}` : c.dim("backup: no global skill dirs yet; skipped"));
    } else {
      console.log(c.dim("backup: skipped"));
    }

    // 2. pre-existing skills on this host that the repo doesn't know
    const scan = yield* findForeign(manifest);
    const candidates = scan.candidates;
    let stateSaved = false;
    if (scan.warning) console.log(c.yellow(`warn: ${scan.warning.message}`));
    if (candidates.length > 0) {
      if (input.adoptAll && !dryRun) {
        const adopted = yield* adoptCandidates(store, manifest, state, candidates, {});
        manifest = adopted.manifest;
        state = adopted.state;
        stateSaved = true;
      } else {
        console.log(c.yellow(`\nfound ${candidates.length} host skill(s) not in the repo (left untouched):`));
        for (const cand of candidates) {
          const prov = cand.lock ? `from ${cand.lock.source}` : "unknown source";
          console.log(`  ${pad(cand.name, 32)}${pad(`~/.${cand.location}`, 12)}${prov}`);
        }
        console.log(c.dim("  import later with `adopt <skill...>` or rerun with --adopt-all"));
      }
    } else {
      console.log("host skills: all known to the repo");
    }

    // 3. materialize enabled skills into the global dirs
    console.log("");
    state = alignStateWithManifest(manifest, state);
    if (!dryRun && !stateSaved) yield* store.saveState(state); // scaffold state when no adoption wrote it
    if (!dryRun) {
      const hostLock = yield* ensureHostSkillLock(manifest);
      yield* seedGlobalSkillLock(manifest, Object.keys(hostLock.entries));
    }
    yield* runSyncCmd(manifest, state, input);

    // 4. integrity
    if (!dryRun) {
      console.log("");
      yield* cmdVerify(manifest);
      const enabledCount = Object.keys(manifest.skills).length - state.disabledSkills.length;
      console.log(`\n${c.green("bootstrap complete")}: ${enabledCount}/${Object.keys(manifest.skills).length} skills enabled`);
      if (candidates.length > 0 && !input.adoptAll) {
        console.log(c.yellow(`${candidates.length} foreign skill(s) pending adoption`));
      }
    }
  });

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    adoptAll: Flag.boolean("adopt-all").pipe(Flag.withDescription("Adopt every foreign host skill into the repo")),
    noBackup: Flag.boolean("no-backup").pipe(Flag.withDescription("Skip the tar backup of the global skill dirs")),
    dryRun: dryRunFlag,
    force: forceFlag,
    clone: Flag.string("clone").pipe(Flag.optional, Flag.withDescription("Fresh machine: git URL of the skills repo to clone first")),
    dest: Flag.string("dest").pipe(Flag.optional, Flag.withDescription("Clone destination (default: ~/<repo-name>)")),
  },
  (input) => (Option.isSome(input.clone) ? cloneBootstrap(input.clone.value, input) : withRepo(bootstrapFlow(input))),
).pipe(Command.withDescription("First-run setup on a host: backup, surface or adopt pre-existing skills, sync, verify"));

const statusCommand = Command.make("status", {}, () =>
  withRepo(
    Effect.gen(function* () {
      const { manifest, state } = yield* loadHostState;
      yield* cmdStatus(manifest, state);
    }),
  ),
).pipe(Command.withDescription("Catalog: origin, enabled, live state, claude link"));

const syncCommand = Command.make("sync", { dryRun: dryRunFlag, force: forceFlag, pull: pullFlag }, (input) =>
  withRepo(
    Effect.gen(function* () {
      if (input.pull) return yield* pullAndSync(input);
      const { manifest, state } = yield* loadHostState;
      yield* runSyncCmd(manifest, state, input);
    }),
  ),
).pipe(Command.withDescription("Reconcile global dirs with manifest + state, optionally after a fast-forward pull"));

const pullCommand = Command.make("pull", { dryRun: dryRunFlag, force: forceFlag }, (input) => withRepo(pullAndSync(input))).pipe(
  Command.withDescription("Fast-forward the catalog from its upstream (replaying diverged local commits), align local state, and sync"),
);

const pushCommand = Command.make("push", { dryRun: dryRunFlag }, ({ dryRun }) =>
  withRepo(
    Effect.gen(function* () {
      const { repo } = yield* HostRepo;
      yield* loadHostState;
      yield* assertGitRoot(repo);
      yield* requireCleanWorktree(repo);
      const { upstream, remote, mergeRef } = yield* requireUpstream(repo);
      const headCommit = (yield* runGit(repo, ["rev-parse", "HEAD^{commit}"])).stdout.trim();
      yield* loadIncomingCatalog(repo, headCommit);
      const hostLock = yield* loadHostSkillLock();
      if (!hostLock.exists) return yield* bail(".skill-lock.json is missing; run `slinky save` before pushing");
      const args = dryRun ? ["push", "--dry-run", remote, `${headCommit}:${mergeRef}`] : ["push", remote, `${headCommit}:${mergeRef}`];
      renderGitOutput(yield* runGit(repo, args));
      console.log(dryRun ? `push to ${upstream} would succeed` : `pushed catalog to ${upstream}`);
    }),
  ),
).pipe(Command.withDescription("Push the clean, verified catalog branch to its configured upstream"));

const makeToggleCommand = (name: "enable" | "disable", description: string) =>
  Command.make(name, { skills: skillsArg, dryRun: dryRunFlag, force: forceFlag }, ({ skills, dryRun, force }) =>
    withRepo(
      Effect.gen(function* () {
        renderAction(yield* setSkillsEnabled(skills, name === "enable", { dryRun, force }));
      }),
    ),
  ).pipe(Command.withDescription(description));

const enableCommand = makeToggleCommand("enable", "Enable skill(s) globally and sync");
const disableCommand = makeToggleCommand("disable", "Disable skill(s) globally and sync");

const profileList = withRepo(
  Effect.gen(function* () {
    const { manifest, state } = yield* loadHostState;
    const entries = Object.entries(manifest.profiles);
    if (entries.length === 0) console.log(c.dim("no profiles defined (edit skills.manifest.json)"));
    for (const [name, skills] of entries) {
      const active = state.activeProfile === name ? c.green(" (active)") : "";
      console.log(`${c.bold(name)}${active}: ${skills.join(", ")}`);
    }
  }),
);

const profileListCommand = Command.make("list", {}, () => profileList).pipe(Command.withDescription("List profiles"));

const profileApplyCommand = Command.make(
  "apply",
  {
    name: Argument.string("name"),
    dryRun: dryRunFlag,
    force: forceFlag,
  },
  ({ name, dryRun, force }) =>
    withRepo(
      Effect.gen(function* () {
        renderAction(yield* applyProfile(name, { dryRun, force }));
      }),
    ),
).pipe(Command.withDescription("Enable exactly the profile's skills"));

const profileCommand = Command.make("profile", {}, () => profileList).pipe(
  Command.withDescription("List profiles or apply one"),
  Command.withSubcommands([profileListCommand, profileApplyCommand]),
);

const configShow = Effect.gen(function* () {
  const paths = yield* Paths;
  const host = RepoResolution.$match(paths.resolution, {
    Found: ({ repo }) => repo,
    NotFound: () => c.dim("(not recorded)"),
    Invalid: ({ error }) => c.red(error.message),
  });
  console.log(`${pad("host", 12)}${host}`);
  console.log(`${pad("diff-pager", 12)}${paths.diffPager ?? c.dim("(none: diffs print inline)")}`);
  const editorSource = paths.editor !== undefined ? "" : c.dim(`  (from ${process.env["VISUAL"] ? "$VISUAL" : process.env["EDITOR"] ? "$EDITOR" : "default"})`);
  console.log(`${pad("editor", 12)}${paths.editorCommand.join(" ")}${editorSource}`);
  console.log(c.dim(`\n${paths.slinkyConfig}`));
});

const configDiffPagerCommand = Command.make("diff-pager", { value: Argument.choice("value", ["hunk", "delta", "none"] as const).pipe(Argument.optional) }, ({ value }) =>
  Effect.gen(function* () {
    const paths = yield* Paths;
    if (Option.isNone(value)) {
      console.log(paths.diffPager ?? c.dim("(none: diffs print inline)"));
      return;
    }
    const next = value.value === "none" ? null : value.value;
    yield* paths.saveDiffPager(next);
    console.log(next === null ? "diff pager cleared; diffs print inline" : `diff pager set to ${next}`);
  }),
).pipe(Command.withDescription("Show or set the pager used by diff and update (hunk, delta, or none)"));

const configEditorCommand = Command.make("editor", { value: Argument.string("command").pipe(Argument.optional) }, ({ value }) =>
  Effect.gen(function* () {
    const paths = yield* Paths;
    if (Option.isNone(value)) {
      console.log(paths.editorCommand.join(" "));
      return;
    }
    const spec = value.value.trim();
    if (spec === "none") {
      yield* paths.saveEditor(null);
      console.log("editor cleared; falling back to $VISUAL, $EDITOR, then nvim");
      return;
    }
    if (parseCommand(spec).length === 0) return yield* bail("editor command cannot be blank");
    yield* paths.saveEditor(spec);
    console.log(`editor set to ${spec}`);
  }),
).pipe(Command.withDescription('Show or set the editor for the TUI (e.g. "code -w", or none to fall back to $VISUAL/$EDITOR)'));

const configCommand = Command.make("config", {}, () => configShow).pipe(
  Command.withDescription("Show Slinky configuration or set the diff pager and editor"),
  Command.withSubcommands([configDiffPagerCommand, configEditorCommand]),
);

const linkCommand = Command.make(
  "link",
  {
    skill: Argument.string("skill"),
    project: Argument.string("project").pipe(Argument.optional),
    copy: Flag.boolean("copy").pipe(Flag.withDescription("Copy the skill into the project (default)")),
    symlink: Flag.boolean("symlink").pipe(Flag.withDescription("Symlink the skill into the project")),
    noExclude: Flag.boolean("no-exclude").pipe(Flag.withDescription("Do not add entries to .git/info/exclude")),
    noClaude: Flag.boolean("no-claude").pipe(Flag.withDescription("Do not create the .claude/skills symlink")),
  },
  (input) =>
    withRepo(
      Effect.gen(function* () {
        const project = Option.getOrElse(input.project, () => process.cwd());
        const mode = input.copy ? "copy" : input.symlink ? "symlink" : "copy";
        const result = yield* linkProjectSkill({
          skill: input.skill,
          project,
          mode,
          gitExclude: !input.noExclude,
          claude: !input.noClaude,
        });
        const link = result.link;
        console.log(`linked ${c.bold(input.skill)} (${mode}) into ${link.project}`);
        for (const t of link.targets) console.log(`  ${t}`);
        if (link.excludedTargets.length > 0) console.log(c.dim("  added to .git/info/exclude"));
      }),
    ),
).pipe(Command.withDescription("Link a skill into a project (project defaults to the current directory)"));

const unlinkCommand = Command.make(
  "unlink",
  {
    skill: Argument.string("skill"),
    project: Argument.string("project").pipe(Argument.optional),
    force: forceFlag,
  },
  (input) =>
    withRepo(
      Effect.gen(function* () {
        const result = yield* unlinkProjectSkill(
          input.skill,
          Option.getOrElse(input.project, () => process.cwd()),
          {
            force: input.force,
          },
        );
        for (const warning of result.warnings) console.log(c.yellow(`warn: ${warning}`));
        console.log(`unlinked ${c.bold(input.skill)} from ${result.link.project}`);
      }),
    ),
).pipe(Command.withDescription("Remove a recorded project link"));

const linksCommand = Command.make("links", { check: Flag.boolean("check").pipe(Flag.withDescription("Verify each link's health")) }, ({ check }) =>
  withRepo(
    Effect.gen(function* () {
      const { manifest, state } = yield* loadHostState;
      const { repo } = yield* HostRepo;
      if (state.projectLinks.length === 0) {
        console.log(c.dim("no project links recorded"));
        return;
      }
      for (const link of state.projectLinks) {
        const status = check ? ` [${checkLink(manifest, link, repo)}]` : "";
        console.log(`${c.bold(link.skill)} -> ${link.project} (${link.mode})${status}`);
      }
    }),
  ),
).pipe(Command.withDescription("List recorded project links"));

const diffCommand = Command.make(
  "diff",
  {
    names: Argument.string("skill").pipe(Argument.variadic()),
    patch: Flag.boolean("patch").pipe(Flag.withDescription("Print the full unified diff")),
    ...pagerFlags,
  },
  ({ names, patch, ...choice }) =>
    withRepo(
      Effect.gen(function* () {
        const pager = yield* selectPager(choice);
        const { manifest } = yield* loadHostState;
        yield* cmdDiff(manifest, names, { patch, pager });
      }),
    ),
).pipe(Command.withDescription("Repo baseline vs live global copy (vendor skills)"));

const vendorCommand = Command.make("vendor", { names: skillsArg }, ({ names }) =>
  withRepo(
    Effect.gen(function* () {
      const { store, manifest: initial } = yield* loadHostState;
      let manifest = initial;
      for (const name of names) {
        const result = yield* vendorAccept(manifest, name);
        manifest = result.manifest;
        console.log(result.changed ? `${name}: vendored live copy into repo` : `${name}: already in sync`);
        if (result.warning) console.log(c.yellow(`warn: ${result.warning.message}`));
      }
      yield* store.saveManifest(manifest);
      console.log(c.dim("review with `git diff` and commit to lock the new baseline"));
    }),
  ),
).pipe(Command.withDescription("Accept live copy into repo (after skills.sh update)"));

const restoreCommand = Command.make("restore", { names: skillsArg }, ({ names }) =>
  withRepo(
    Effect.gen(function* () {
      const restoreAll = names.length === 1 && names[0] === "all";
      if (!restoreAll && names.includes("all")) return yield* bail("restore all cannot be combined with skill names");
      const { manifest } = yield* loadHostState;
      let targets = names;
      if (restoreAll) {
        const paths = yield* Paths;
        const observation = yield* observe();
        targets = Object.entries(manifest.skills)
          .filter(([name, meta]) => {
            const live = observation.agents[name];
            return meta.origin === "vendor" && live?.kind === "dir" && contentHash(join(paths.agentsSkills, name)) !== meta.contentHash;
          })
          .map(([name]) => name);
      }
      for (const name of targets) {
        yield* vendorRestore(manifest, name);
        console.log(`${name}: live copy restored from repo baseline`);
      }
      if (restoreAll && targets.length === 0) console.log("all live vendor skills already match the catalog");
    }),
  ),
).pipe(Command.withDescription("Reset selected live copies, or all drift with `restore all`, from the repo baseline"));

const rehashCommand = Command.make("rehash", { names: optionalSkillsArg }, ({ names }) =>
  withRepo(
    Effect.gen(function* () {
      const { store, manifest: initial } = yield* loadHostState;
      const { repo } = yield* HostRepo;
      // Named skills are validated up front so a typo or a vendor skill still fails loudly; with no
      // names the command sweeps every local skill and stays quiet about the ones already current.
      for (const name of names) {
        const meta = getSkill(initial, name);
        if (!meta) return yield* bail(`unknown skill: ${name}`);
        if (meta.origin !== "local") return yield* bail(`${name} is a vendor skill; use vendor after reviewing live drift`);
        if (!existsSync(join(repo, meta.path))) return yield* bail(`${name}: repo copy missing at ${meta.path}`);
      }
      const { manifest, refreshed } = refreshLocalHashes(initial, repo, names.length > 0 ? names : undefined);
      if (names.length > 0) {
        for (const name of names) console.log(refreshed.includes(name) ? `${name}: refreshed manifest hash` : `${name}: already current`);
      } else {
        for (const name of refreshed) console.log(`${name}: refreshed manifest hash`);
        if (refreshed.length === 0) console.log("all local skills already current");
      }
      if (refreshed.length > 0) yield* store.saveManifest(manifest);
    }),
  ),
).pipe(Command.withDescription("Refresh manifest hashes after editing local skills (every stale local skill when none are named)"));

const skillsAddCommand = Command.make(
  "add",
  {
    source: Argument.string("source"),
    skill: Flag.string("skill").pipe(Flag.atLeast(0), Flag.withDescription("Skill to install; repeat for several, omit to pick from skills.sh")),
  },
  ({ source, skill }) =>
    withRepo(
      Effect.gen(function* () {
        const { repo } = yield* HostRepo;
        const { store, manifest: initial, state: initialState } = yield* loadHostState;
        const foreignBefore = yield* findForeign(initial);
        const foreignHashes = new Map(foreignBefore.candidates.map((candidate) => [candidate.name, contentHash(candidate.dir)]));
        // Hand discovery to skills.sh: with no --skill it runs its own picker,
        // so Slinky never has to reimplement listing a remote source.
        console.log(c.bold(`running npx skills add ${source} in ${repo}\n`));
        yield* runSkillsAdd(source, skill, repo);

        let manifest = initial;
        let state = initialState;
        const pool = yield* collectAdoptable(manifest);
        for (const warning of pool.warnings) console.log(c.yellow(`warn: ${warning}`));
        for (const entry of pool.changed) {
          console.log(c.yellow(`warn: ${entry.name}: staged copy differs from ${entry.path}; updating a vendored skill from the inbox is not supported yet (left in place)`));
        }

        // skills.sh currently ignores `--project` during interactive adds. If the
        // user chooses Global, include only host copies changed by this invocation.
        const picked = pool.candidates.filter((candidate) => candidate.location === "staged" || foreignHashes.get(candidate.name) !== contentHash(candidate.dir));
        const globalPicks = picked.filter((candidate) => candidate.location !== "staged");
        if (globalPicks.length > 0) console.log(c.dim(`indexing ${globalPicks.length} skill(s) installed globally by skills.sh`));
        yield* dropRedundantStaging(pool);
        if (picked.length === 0) {
          if (pool.redundant.length === 0) console.log("nothing new to index");
          return;
        }

        const adopted = yield* adoptCandidates(store, manifest, state, picked, {});
        manifest = adopted.manifest;
        state = adopted.state;
        for (const warning of adopted.warnings) console.log(c.yellow(`warn: ${warning}`));
        yield* runSyncCmd(manifest, state, {});
        yield* suggestStagingIgnore();
        console.log(c.dim("review with `git status` and commit to lock the new baseline"));
      }),
    ),
).pipe(Command.withDescription("Install with skills.sh into the repo, then vendor, index, and sync"));

const skillsCommand = Command.make("skills").pipe(Command.withDescription("skills.sh integration"), Command.withSubcommands([skillsAddCommand]));

const adoptCommand = Command.make(
  "adopt",
  {
    names: Argument.string("skill").pipe(Argument.variadic()),
    all: Flag.boolean("all").pipe(Flag.withDescription("Adopt every candidate")),
    local: Flag.boolean("local").pipe(Flag.withDescription("Adopt as locally-authored skills into skills/")),
    owner: Flag.string("owner").pipe(Flag.optional, Flag.withDescription("Vendor owner directory when provenance is unknown")),
    force: forceFlag,
  },
  (input) =>
    withRepo(
      Effect.gen(function* () {
        const positionalAll = input.names.length === 1 && input.names[0] === "all";
        if (!positionalAll && input.names.includes("all")) return yield* bail("adopt all cannot be combined with skill names");
        const adoptAll = input.all || positionalAll;
        const { store, manifest: initial, state: initialState } = yield* loadHostState;
        let manifest = initial;
        let state = initialState;
        const pool = yield* collectAdoptable(manifest);
        const candidates = pool.candidates;
        for (const warning of pool.warnings) console.log(c.yellow(`warn: ${warning}`));
        for (const entry of pool.changed) {
          console.log(c.yellow(`warn: ${entry.name}: staged copy differs from ${entry.path}; updating a vendored skill from the inbox is not supported yet (left in place)`));
        }
        if (input.names.length === 0 && !adoptAll) {
          if (candidates.length === 0 && pool.redundant.length === 0) {
            console.log(c.green("nothing to adopt; all staged and host skills are in the repo"));
            return;
          }
          if (candidates.length > 0) {
            console.log(c.bold("skills not in the repo:"));
            for (const cand of candidates) {
              const prov = cand.lock ? `from ${cand.lock.source}` : c.yellow("unknown source");
              console.log(`  ${pad(cand.name, 32)}${pad(originLabel(cand), 16)}${prov}`);
            }
          }
          for (const entry of pool.redundant) {
            console.log(c.dim(`  ${pad(entry.name, 32)}${pad(".agents/skills", 16)}already indexed at ${entry.path}; staging copy is redundant`));
          }
          console.log(c.dim("\nadopt with: adopt <skill...> [--local] [--owner=<x>]  or  adopt all"));
          return;
        }
        let picked: ReadonlyArray<ForeignSkill>;
        if (adoptAll) {
          picked = candidates;
        } else {
          const chosen: ForeignSkill[] = [];
          for (const name of input.names) {
            const cand = candidates.find((x) => x.name === name);
            if (!cand) return yield* bail(`no adoptable skill named ${name} (see \`adopt\` for candidates)`);
            chosen.push(cand);
          }
          picked = chosen;
        }
        // Adopting all also clears staging copies that duplicate an existing baseline.
        if (adoptAll) yield* dropRedundantStaging(pool);
        if (picked.length === 0) {
          if (pool.redundant.length === 0) console.log("nothing to adopt");
          return;
        }
        const options: AdoptOptions = Option.isSome(input.owner) ? { local: input.local, owner: input.owner.value } : { local: input.local };
        const adopted = yield* adoptCandidates(store, manifest, state, picked, options);
        manifest = adopted.manifest;
        state = adopted.state;
        for (const warning of adopted.warnings) console.log(c.yellow(`warn: ${warning}`));
        yield* runSyncCmd(manifest, state, { force: input.force });
        yield* suggestStagingIgnore();
        console.log(c.dim("review with `git status` and commit to lock the new baseline"));
      }),
    ),
).pipe(Command.withDescription("List staged and host skills not yet in the repo, or import them (never nukes them)"));

const updateCommand = Command.make(
  "update",
  {
    names: Argument.string("skill").pipe(Argument.variadic()),
    check: Flag.boolean("check").pipe(Flag.withDescription("Compare installed skills against upstream (no changes)")),
    yes: Flag.boolean("yes").pipe(Flag.withAlias("y"), Flag.withDescription("Accept every changed skill without prompting")),
    force: forceFlag,
    ...pagerFlags,
  },
  (input) =>
    withRepo(
      Effect.gen(function* () {
        const paths = yield* Paths;
        const { repo } = yield* HostRepo;
        const { store, manifest: initial, state } = yield* loadHostState;
        let manifest = initial;
        if (input.check) {
          console.log(c.dim("comparing persisted upstream hashes against GitHub\u2026"));
          const statuses = yield* checkUpstream(manifest);
          const label = {
            current: c.green("up to date"),
            update: c.yellow("update available"),
            gone: c.red("gone upstream (kept: vendored)"),
            unchecked: c.dim("unchecked"),
          } satisfies Record<(typeof statuses)[number]["state"], string>;
          for (const s of statuses.filter((x) => x.state !== "current")) {
            console.log(`  ${pad(s.name, 32)}${label[s.state]}${s.detail ? c.dim(`  ${s.detail}`) : ""}`);
          }
          const counts = statuses.reduce<Record<string, number>>((acc, s) => {
            acc[s.state] = (acc[s.state] ?? 0) + 1;
            return acc;
          }, {});
          console.log(`\n${counts["update"] ?? 0} update(s), ${counts["current"] ?? 0} current, ` + `${counts["gone"] ?? 0} gone upstream, ${counts["unchecked"] ?? 0} unchecked`);
          return;
        }

        const vendorNames = Object.entries(manifest.skills)
          .filter(([, meta]) => meta.origin === "vendor")
          .map(([name]) => name);
        const selectedNames = input.names.length > 0 ? input.names : vendorNames;
        for (const name of selectedNames) {
          const meta = getSkill(manifest, name);
          if (!meta) return yield* bail(`unknown skill: ${name}`);
          if (meta.origin !== "vendor") return yield* bail(`${name} is a local skill; it cannot be updated through skills.sh`);
        }
        if (selectedNames.length === 0) {
          console.log(c.dim("no vendor skills to update"));
          return;
        }

        // 1. preflight: the committed baseline is the snapshot we diff against
        const hostLock = yield* ensureHostSkillLock(manifest);
        if (hostLock.changed && !input.force) {
          return yield* bail("created or refreshed .skill-lock.json; review it and run `slinky save` before updating (--force to override)");
        }
        if ((yield* baselineDirty()) && !input.force) {
          return yield* bail("catalog baseline has uncommitted changes; commit or stash first (--force to override)");
        }

        // 2. fetch via skills.sh (updates live copies + lock; baselines untouched)
        console.log(c.bold("running npx skills update\u2026\n"));
        yield* runSkillsUpdate(manifest, selectedNames);

        // 3. detect what actually changed vs our baselines
        const outcome = yield* detectChanges(manifest, state, selectedNames);
        if (outcome.changed.length === 0 && outcome.missing.length === 0) {
          console.log(c.green("\nno changes: all live copies still match the vendored baselines"));
          return;
        }

        // 4. review: one aggregate session over every change, then decide per skill
        const pager = yield* selectPager(input);
        const pathsFor = (name: string) => {
          const meta = getSkill(manifest, name);
          return meta ? { repoPath: join(repo, meta.path), live: join(paths.agentsSkills, name) } : undefined;
        };
        if (pager && !input.yes) {
          const patches: string[] = [];
          for (const name of outcome.changed) {
            const target = pathsFor(name);
            if (target) patches.push(yield* renderPatch(target.repoPath, target.live));
          }
          if (patches.length > 0) {
            console.log(c.dim(`\nreviewing ${outcome.changed.length} changed skill(s) in ${pager}\u2026`));
            yield* openPager(patches.join("\n"), pager);
          }
        }

        const accepted: string[] = [];
        const rejected: string[] = [];
        for (const name of outcome.changed) {
          const target = pathsFor(name);
          if (!target) continue;
          const { repoPath, live } = target;
          const d = diffDirs(repoPath, live);
          console.log(c.bold(`\n\u2500\u2500 ${name} \u2500\u2500`));
          for (const f of d.added) console.log(c.green(`  + ${f}`));
          for (const f of d.removed) console.log(c.red(`  - ${f}`));
          for (const f of d.modified) console.log(c.yellow(`  ~ ${f}`));

          let decision = input.yes ? "a" : "";
          while (!["a", "r", "s"].includes(decision)) {
            decision = (prompt(`accept [a] / reject [r] / skip [s] / show diff [d] >`) ?? "s").trim().toLowerCase();
            if (decision === "d") {
              const rendered = yield* renderPatch(repoPath, live);
              if (pager) yield* openPager(rendered, pager);
              else console.log(rendered);
              decision = "";
            }
          }
          if (decision === "a") {
            const result = yield* vendorAccept(manifest, name, { refreshProvenance: true });
            manifest = result.manifest;
            if (result.warning) console.log(c.yellow(`  warn: ${result.warning.message}`));
            accepted.push(name);
            console.log(c.green(`  accepted: new baseline for ${name}`));
          } else if (decision === "r") {
            yield* vendorRestore(manifest, name);
            rejected.push(name);
            console.log(c.yellow(`  rejected: live copy restored from baseline`));
          } else {
            console.log(c.dim("  skipped (live copy stays changed; status will show drift)"));
          }
        }
        if (accepted.length > 0) {
          const previousLock = yield* loadHostSkillLock();
          yield* Effect.gen(function* () {
            yield* absorbGlobalSkillLockEntries(manifest, accepted);
            yield* store.saveManifest(manifest);
          }).pipe(Effect.onError(() => restoreHostSkillLock(previousLock).pipe(Effect.ignore)));
        }
        yield* seedGlobalSkillLock(manifest, selectedNames);

        // 5. resurrect enabled skills that upstream deleted
        if (outcome.missing.length > 0) {
          console.log(c.yellow(`\ngone upstream, restoring from vendored baseline: ${outcome.missing.join(", ")}`));
          yield* runSyncCmd(manifest, state, {});
        }

        console.log(
          `\n${c.bold("summary:")} ${accepted.length} accepted, ${rejected.length} rejected, ` +
            `${outcome.changed.length - accepted.length - rejected.length} skipped, ${outcome.missing.length} restored`,
        );
        if (accepted.length > 0) {
          console.log(c.dim(`review with \`git diff\` then commit to lock the new baseline`));
        }
      }),
    ),
).pipe(Command.withDescription("Check upstream (--check) or fetch updates via skills.sh and review each diff"));

const saveCommand = Command.make(
  "save",
  {
    message: Flag.string("message").pipe(Flag.withAlias("m"), Flag.optional, Flag.withDescription("Git commit message (default: Update skills catalog)")),
  },
  ({ message }) =>
    withRepo(
      Effect.gen(function* () {
        const store = yield* ManifestStore;
        let manifest = yield* store.loadManifest();
        const { repo } = yield* HostRepo;
        const topLevel = yield* runGit(repo, ["rev-parse", "--show-toplevel"]);
        if (realpathSync(topLevel.stdout.trim()) !== realpathSync(repo)) {
          return yield* bail(`skills host must be a Git repository root: ${repo}`);
        }
        const unindexed = findUnindexedSkills(manifest, repo).filter((skill) => skill.origin !== "agent");
        if (unindexed.length > 0) return yield* bail(`unindexed catalog skill: ${unindexed.map((skill) => skill.path).join(", ")}`);

        yield* ensureHostSkillLock(manifest);
        // Editing a local skill edits the repo copy through its symlink, and save commits that
        // content either way, so a stale local hash is bookkeeping rather than a reason to stop.
        // Every other verification failure below still aborts the commit.
        const refresh = refreshLocalHashes(manifest, repo);
        if (refresh.refreshed.length > 0) {
          manifest = refresh.manifest;
          for (const name of refresh.refreshed) console.log(`${name}: refreshed manifest hash`);
          yield* store.saveManifest(manifest);
        }
        yield* cmdVerify(manifest);
        const committedManifest = yield* runGit(repo, ["show", "HEAD:skills.manifest.json"]);
        const previous = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(Manifest)(JSON.parse(committedManifest.stdout)),
          catch: (error) => new OperationFailed({ message: `cannot decode committed skills.manifest.json: ${errorDetail(error)}` }),
        });
        const previousPaths = Object.values(previous.skills).map((skill) => skill.path);
        const committedFiles = yield* runGit(repo, ["ls-tree", "-r", "--name-only", "HEAD", "--", ...previousPaths]);
        const currentFiles = Object.values(manifest.skills).flatMap((skill) => walkFiles(join(repo, skill.path)).map((file) => posix.join(skill.path, file)));
        const pathspec = [".skill-lock.json", "skills.manifest.json", ...new Set([...committedFiles.stdout.split("\n").filter(Boolean), ...currentFiles])];
        const status = yield* runGit(repo, ["status", "--porcelain", "--", ...pathspec]);
        if (status.stdout.trim().length === 0) {
          console.log(c.green("catalog already saved; nothing to commit"));
          return;
        }

        const commitMessage = Option.getOrElse(message, () => "Update skills catalog");
        const index = yield* runGit(repo, ["rev-parse", "--git-path", "index"]);
        const indexPath = resolve(repo, index.stdout.trim());
        const indexBackup = `${indexPath}.slinky-${process.pid}`;
        yield* Effect.try({
          try: () => copyFileSync(indexPath, indexBackup),
          catch: (error) => new ExternalToolError({ tool: "git", message: `could not back up Git index: ${errorDetail(error)}` }),
        });
        const commit = yield* Effect.gen(function* () {
          yield* runGit(repo, ["add", "--intent-to-add", "--", ".skill-lock.json", "skills.manifest.json", ...currentFiles]);
          return yield* runGit(repo, ["commit", "--only", "-m", commitMessage, "--", ...pathspec]);
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
          console.log(c.yellow(`warn: commit succeeded, but could not remove Git index backup ${indexBackup}: ${errorDetail(error)}`));
        }
        if (commit.stdout.trim()) console.log(commit.stdout.trim());
        const revision = yield* runGit(repo, ["rev-parse", "--short", "HEAD"]);
        console.log(c.green(`saved catalog as ${revision.stdout.trim()}`));
      }),
    ),
).pipe(Command.withDescription("Verify and commit catalog-managed paths in the skills host"));

const verifyCommand = Command.make("verify", {}, () =>
  withRepo(
    Effect.gen(function* () {
      const { manifest } = yield* loadHostState;
      yield* cmdVerify(manifest);
    }),
  ),
).pipe(Command.withDescription("Hash-check every skill against the manifest"));

const versionCommand = Command.make("version", {}, () => Effect.sync(() => console.log(`slinky ${packageJson.version}`))).pipe(
  Command.withDescription("Print the installed Slinky version"),
);

const root = Command.make("slinky").pipe(
  Command.withDescription("Slinky skill manager (no command opens the TUI)"),
  Command.withSubcommands([
    tuiCommand,
    initCommand,
    bootstrapCommand,
    statusCommand,
    syncCommand,
    pullCommand,
    pushCommand,
    enableCommand,
    disableCommand,
    profileCommand,
    configCommand,
    linkCommand,
    unlinkCommand,
    linksCommand,
    diffCommand,
    updateCommand,
    skillsCommand,
    vendorCommand,
    restoreCommand,
    rehashCommand,
    adoptCommand,
    saveCommand,
    verifyCommand,
    versionCommand,
  ]),
);

// --- runtime boundary -----------------------------------------------------

function renderFailure(cause: unknown): never {
  // Usage errors and help output are already rendered by the CLI framework.
  if (CliError.isCliError(cause)) process.exit(1);
  if (cause instanceof RepoNotFoundError) {
    const slinkyConfig = join(homedir(), ".config", "slinky", "config.json");
    console.error(
      c.red(
        `error: no skills repo found. slinky looks in $SLINKY_REPO, ${slinkyConfig}, and parent dirs.\n` +
          `  existing clone:  slinky init <path-to-clone>\n` +
          `  fresh machine:   slinky bootstrap --clone=<git-url> [--dest=<path>]`,
      ),
    );
    process.exit(1);
  }
  console.error(c.red(`error: ${cause instanceof Error ? cause.message : String(cause)}`));
  process.exit(1);
}

const argv = process.argv.slice(2);
const effectiveArgv = argv.length === 0 ? ["tui"] : argv[0] === "help" && argv.length === 1 ? ["--help"] : argv;

const exit = await Effect.runPromiseExit(
  Command.runWith(root, { version: packageJson.version })(effectiveArgv).pipe(Effect.provide(Layer.mergeAll(Paths.layer, BunServices.layer))),
);
if (Exit.isFailure(exit)) renderFailure(Cause.squash(exit.cause));
