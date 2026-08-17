#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
import { contentHash, findSymlinks } from "./lib/hash.ts";
import { diffDirs, isClean, unifiedDiff } from "./lib/diff.ts";
import { layerRepo } from "./lib/layers.ts";
import { checkLink } from "./lib/linker.ts";
import { alignStateWithManifest, getSkill, isSkillEnabled, Manifest, ManifestStore, withManifestSkill } from "./lib/manifest.ts";
import type { ManifestStoreInterface, State } from "./lib/manifest.ts";
import { HostRepo, isRepoDir, Paths, RepoNotFoundError } from "./lib/paths.ts";
import { apply, observe, observeAndPlan } from "./lib/reconcile.ts";
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

const cmdDiff = Effect.fn("Cli.diff")(function* (manifest: Manifest, names: ReadonlyArray<string>, patch: boolean) {
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;
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
    console.log(c.bold(`${name}: ${c.yellow("differs from repo baseline")}`));
    for (const f of d.added) console.log(c.green(`  + ${f}`));
    for (const f of d.removed) console.log(c.red(`  - ${f}`));
    for (const f of d.modified) console.log(c.yellow(`  ~ ${f}`));
    if (patch) console.log(unifiedDiff(repoPath, live));
  }
  if (names.length === 0) {
    console.log(dirty === 0 ? c.green("\nall vendored skills in sync") : c.yellow(`\n${dirty} skill(s) differ`));
  }
});

const cmdVerify = Effect.fn("Cli.verify")(function* (manifest: Manifest) {
  const { repo } = yield* HostRepo;
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
  if (bad > 0) return yield* bail(`${bad} catalog verification problem(s)`);
  console.log(c.green(`all ${Object.keys(manifest.skills).length} skills verified`));
});

const runGit = Effect.fn("Cli.runGit")(function* (repo: string, args: ReadonlyArray<string>) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"]) {
    delete env[name];
  }
  const result = yield* Effect.sync(() => spawnSync("git", ["--literal-pathspecs", ...args], { cwd: repo, encoding: "utf8", env }));
  if (result.error) {
    return yield* Effect.fail(new ExternalToolError({ tool: "git", message: result.error.message }));
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return yield* Effect.fail(new ExternalToolError({ tool: "git", message: detail || `git exited with ${result.status ?? "unknown"}` }));
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
  let manifest = initialManifest;
  let state = initialState;
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
      if (cand.location === "staged") staged.push(cand.name);
      manifest = result.manifest;
      console.log(`adopted ${c.bold(cand.name)} -> ${result.meta.path}`);
    }
    state = alignStateWithManifest(manifest, state);
    yield* store.saveManifest(manifest);
    manifestWritten = true;
    yield* store.saveState(state);
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
const skillsArg = Argument.string("skill").pipe(Argument.variadic({ min: 1 }));

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

const syncCommand = Command.make("sync", { dryRun: dryRunFlag, force: forceFlag }, (input) =>
  withRepo(
    Effect.gen(function* () {
      const { manifest, state } = yield* loadHostState;
      yield* runSyncCmd(manifest, state, input);
    }),
  ),
).pipe(Command.withDescription("Reconcile global dirs with manifest + state"));

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
        const { repo } = yield* HostRepo;
        const project = Option.getOrElse(input.project, () => process.cwd());
        if (resolveDir(project) === repo) return yield* bail("refusing to link a skill into the skills repo itself");
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
  },
  ({ names, patch }) =>
    withRepo(
      Effect.gen(function* () {
        const { manifest } = yield* loadHostState;
        yield* cmdDiff(manifest, names, patch);
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
      const { manifest } = yield* loadHostState;
      for (const name of names) {
        yield* vendorRestore(manifest, name);
        console.log(`${name}: live copy restored from repo baseline`);
      }
    }),
  ),
).pipe(Command.withDescription("Reset live copy from repo baseline (reject update)"));

const rehashCommand = Command.make("rehash", { names: skillsArg }, ({ names }) =>
  withRepo(
    Effect.gen(function* () {
      const { store, manifest: initial } = yield* loadHostState;
      const { repo } = yield* HostRepo;
      let manifest = initial;
      let changed = false;
      for (const name of names) {
        const meta = getSkill(manifest, name);
        if (!meta) return yield* bail(`unknown skill: ${name}`);
        if (meta.origin !== "local") return yield* bail(`${name} is a vendor skill; use vendor after reviewing live drift`);
        const path = join(repo, meta.path);
        if (!existsSync(path)) return yield* bail(`${name}: repo copy missing at ${meta.path}`);
        const hash = contentHash(path);
        if (hash === meta.contentHash) {
          console.log(`${name}: already current`);
          continue;
        }
        manifest = withManifestSkill(manifest, name, { ...meta, contentHash: hash });
        changed = true;
        console.log(`${name}: refreshed manifest hash`);
      }
      if (changed) yield* store.saveManifest(manifest);
    }),
  ),
).pipe(Command.withDescription("Refresh manifest hashes after editing local skills"));

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
        // Hand discovery to skills.sh: with no --skill it runs its own picker,
        // so Slinky never has to reimplement listing a remote source.
        console.log(c.bold(`running npx skills add ${source} in ${repo}\n`));
        yield* runSkillsAdd(source, skill, repo);

        const { store, manifest: initial, state: initialState } = yield* loadHostState;
        let manifest = initial;
        let state = initialState;
        const pool = yield* collectAdoptable(manifest);
        for (const warning of pool.warnings) console.log(c.yellow(`warn: ${warning}`));
        for (const entry of pool.changed) {
          console.log(c.yellow(`warn: ${entry.name}: staged copy differs from ${entry.path}; updating a vendored skill from the inbox is not supported yet (left in place)`));
        }

        // Only consolidate the inbox; unrelated host skills stay for `slinky adopt`.
        const picked = pool.candidates.filter((cand) => cand.location === "staged");
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
        const { store, manifest: initial, state: initialState } = yield* loadHostState;
        let manifest = initial;
        let state = initialState;
        const pool = yield* collectAdoptable(manifest);
        const candidates = pool.candidates;
        for (const warning of pool.warnings) console.log(c.yellow(`warn: ${warning}`));
        for (const entry of pool.changed) {
          console.log(c.yellow(`warn: ${entry.name}: staged copy differs from ${entry.path}; updating a vendored skill from the inbox is not supported yet (left in place)`));
        }
        if (input.names.length === 0 && !input.all) {
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
          console.log(c.dim("\nadopt with: adopt <skill...> [--local] [--owner=<x>]  or  adopt --all"));
          return;
        }
        let picked: ReadonlyArray<ForeignSkill>;
        if (input.all) {
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
        // --all also clears staging copies that duplicate an existing baseline.
        if (input.all) yield* dropRedundantStaging(pool);
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
        if ((yield* baselineDirty()) && !input.force) {
          return yield* bail("vendor/skills baseline has uncommitted changes; commit or stash first (--force to override)");
        }

        // 2. fetch via skills.sh (updates live copies + lock; baselines untouched)
        console.log(c.bold("running npx skills update\u2026\n"));
        yield* runSkillsUpdate(selectedNames);

        // 3. detect what actually changed vs our baselines
        const outcome = yield* detectChanges(manifest, state, selectedNames);
        if (outcome.changed.length === 0 && outcome.missing.length === 0) {
          console.log(c.green("\nno changes: all live copies still match the vendored baselines"));
          return;
        }

        // 4. review + decide per skill
        const accepted: string[] = [];
        const rejected: string[] = [];
        for (const name of outcome.changed) {
          const meta = getSkill(manifest, name);
          if (!meta) continue;
          const repoPath = join(repo, meta.path);
          const live = join(paths.agentsSkills, name);
          const d = diffDirs(repoPath, live);
          console.log(c.bold(`\n\u2500\u2500 ${name} \u2500\u2500`));
          for (const f of d.added) console.log(c.green(`  + ${f}`));
          for (const f of d.removed) console.log(c.red(`  - ${f}`));
          for (const f of d.modified) console.log(c.yellow(`  ~ ${f}`));

          let decision = input.yes ? "a" : "";
          while (!["a", "r", "s"].includes(decision)) {
            decision = (prompt(`accept [a] / reject [r] / skip [s] / show diff [d] >`) ?? "s").trim().toLowerCase();
            if (decision === "d") {
              console.log(unifiedDiff(repoPath, live));
              decision = "";
            }
          }
          if (decision === "a") {
            const result = yield* vendorAccept(manifest, name);
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
        if (accepted.length > 0) yield* store.saveManifest(manifest);

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
        const manifest = yield* store.loadManifest();
        const { repo } = yield* HostRepo;
        const topLevel = yield* runGit(repo, ["rev-parse", "--show-toplevel"]);
        if (realpathSync(topLevel.stdout.trim()) !== realpathSync(repo)) {
          return yield* bail(`skills host must be a Git repository root: ${repo}`);
        }
        const unindexed = findUnindexedSkills(manifest, repo).filter((skill) => skill.origin !== "agent");
        if (unindexed.length > 0) return yield* bail(`unindexed catalog skill: ${unindexed.map((skill) => skill.path).join(", ")}`);

        yield* cmdVerify(manifest);
        const committedManifest = yield* runGit(repo, ["show", "HEAD:skills.manifest.json"]);
        const previous = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(Manifest)(JSON.parse(committedManifest.stdout)),
          catch: (error) => new OperationFailed({ message: `cannot decode committed skills.manifest.json: ${errorDetail(error)}` }),
        });
        const pathspec = [
          "skills.manifest.json",
          ...new Set([...Object.values(previous.skills).map((skill) => skill.path), ...Object.values(manifest.skills).map((skill) => skill.path)]),
        ];
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
          yield* runGit(repo, ["add", "--", ...pathspec]);
          yield* runGit(repo, ["diff", "--cached", "--check", "--", ...pathspec]);
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

const root = Command.make("slinky").pipe(
  Command.withDescription("Slinky skill manager (no command opens the TUI)"),
  Command.withSubcommands([
    tuiCommand,
    initCommand,
    bootstrapCommand,
    statusCommand,
    syncCommand,
    enableCommand,
    disableCommand,
    profileCommand,
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
