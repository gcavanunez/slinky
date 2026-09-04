import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import packageJson from "../../package.json" with { type: "json" };
import { alignStateWithManifest, defaultThemeId, getDisabledSkills, themeIds } from "../domain/model.ts";
import { findForeign } from "../lib/adopt.ts";
import { adoptSkills } from "../lib/adopt.ts";
import { backupGlobalDirs } from "../lib/bootstrap.ts";
import { parseCommand } from "../lib/editor.ts";
import { isRepoDir, Paths, RepoResolution } from "../lib/paths.ts";
import { ensureHostSkillLock, seedGlobalSkillLock } from "../lib/skill-lock.ts";
import { cmdVerify } from "./catalog-commands.ts";
import { c, pad, renderAdoptions } from "./render.ts";
import { bail, dryRunFlag, forceFlag, loadHostState, runSyncCmd, withRepo, switchFlag } from "./shared.ts";

function resolveDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export const tuiCommand = Command.make("tui", {}, () =>
  Effect.gen(function* () {
    // Repo discovery must succeed before handing the terminal to the TUI.
    yield* withRepo(Effect.void);
    yield* Effect.promise(async () => {
      const { runTui } = await import("../tui/index.tsx");
      await runTui();
    });
  }),
).pipe(Command.withDescription("Interactive catalog (default)"));

export const initCommand = Command.make(
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
        const adopted = yield* adoptSkills(
          store,
          manifest,
          state,
          candidates.map((candidate) => ({ candidate })),
        );
        manifest = adopted.manifest;
        state = adopted.state;
        stateSaved = true;
        renderAdoptions(adopted);
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
      yield* cmdVerify();
      const enabledCount = Object.keys(manifest.skills).length - getDisabledSkills(manifest, state).length;
      console.log(`\n${c.green("bootstrap complete")}: ${enabledCount}/${Object.keys(manifest.skills).length} skills enabled`);
      if (candidates.length > 0 && !input.adoptAll) {
        console.log(c.yellow(`${candidates.length} foreign skill(s) pending adoption`));
      }
    }
  });

export const bootstrapCommand = Command.make(
  "bootstrap",
  {
    adoptAll: switchFlag("adopt-all", "Adopt every foreign host skill into the repo"),
    noBackup: switchFlag("no-backup", "Skip the tar backup of the global skill dirs"),
    dryRun: dryRunFlag,
    force: forceFlag,
    clone: Flag.string("clone").pipe(Flag.optional, Flag.withDescription("Fresh machine: git URL of the skills repo to clone first")),
    dest: Flag.string("dest").pipe(Flag.optional, Flag.withDescription("Clone destination (default: ~/<repo-name>)")),
  },
  (input) => (Option.isSome(input.clone) ? cloneBootstrap(input.clone.value, input) : withRepo(bootstrapFlow(input))),
).pipe(Command.withDescription("First-run setup on a host: backup, surface or adopt pre-existing skills, sync, verify"));

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
  console.log(`${pad("theme", 12)}${paths.theme ?? c.dim(`(default: ${defaultThemeId})`)}`);
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

const configThemeCommand = Command.make("theme", { value: Argument.choice("value", [...themeIds, "none"] as const).pipe(Argument.optional) }, ({ value }) =>
  Effect.gen(function* () {
    const paths = yield* Paths;
    if (Option.isNone(value)) {
      console.log(paths.theme ?? defaultThemeId);
      return;
    }
    const next = value.value === "none" ? null : value.value;
    yield* paths.saveTheme(next);
    console.log(next === null ? `theme cleared; using ${defaultThemeId}` : `theme set to ${next}`);
  }),
).pipe(Command.withDescription("Show or set the TUI theme (press t in the TUI to preview; none restores the default)"));

export const configCommand = Command.make("config", {}, () => configShow).pipe(
  Command.withDescription("Show Slinky configuration or set the diff pager, editor, and theme"),
  Command.withSubcommands([configDiffPagerCommand, configEditorCommand, configThemeCommand]),
);

export const versionCommand = Command.make("version", {}, () => Effect.sync(() => console.log(`slinky ${packageJson.version}`))).pipe(
  Command.withDescription("Print the installed Slinky version"),
);
