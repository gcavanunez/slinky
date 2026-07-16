#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  adoptSkill,
  finalizeAdoption,
  findForeign,
  rollbackAdoption,
} from "./lib/adopt.ts";
import type { Adoption } from "./lib/adopt.ts";
import { backupGlobalDirs } from "./lib/bootstrap.ts";
import { contentHash } from "./lib/hash.ts";
import { diffDirs, isClean, unifiedDiff } from "./lib/diff.ts";
import { applyUnlink, checkLink, linkSkill, prepareUnlink, unlinkSkill } from "./lib/linker.ts";
import {
  alignStateWithManifest,
  getProfile,
  getSkill,
  isSkillEnabled,
  loadManifest,
  loadState,
  saveManifest,
  saveState,
  withProfile,
  withManifestSkill,
  withSkillEnabled,
} from "./lib/manifest.ts";
import type { Manifest, State } from "./lib/manifest.ts";
import {
  AGENTS_SKILLS,
  HOME,
  isRepoDir,
  REPO,
  repoFound,
  repoResolutionError,
  saveHostConfig,
  SLINKY_CONFIG,
} from "./lib/paths.ts";
import { apply, observe, planSync } from "./lib/reconcile.ts";
import { vendorAccept, vendorRestore } from "./lib/vendorOps.ts";
import { baselineDirty, checkUpstream, detectChanges, runSkillsUpdate } from "./lib/update.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const HELP = `${c.bold("Slinky skill manager")}

Usage: slinky [command]            no command opens the TUI

  tui                             interactive catalog (default)
  init [path]                     record the skills repo clone location
                                   (also: $SLINKY_REPO env var overrides)
  bootstrap [--adopt-all] [--no-backup] [--dry-run] [--force]
                                   first-run setup on a host: backup, surface or
                                   adopt pre-existing skills, sync, verify
  bootstrap --clone=<git-url> [--dest=<path>]
                                  fresh machine: clone the skills repo first,
                                  record it, then bootstrap (dest: ~/<repo-name>)
  status                          catalog: origin, enabled, live state, claude link
  sync [--dry-run] [--force]      reconcile global dirs with manifest + state
  enable <skill...>               enable skill(s) globally and sync
  disable <skill...> [--force]    disable skill(s) globally and sync
  profile list                    list profiles
  profile apply <name> [--force]  enable exactly the profile's skills
  link <skill> [project] [--copy|--symlink] [--no-exclude] [--no-claude]
                                  project defaults to the current directory
  unlink <skill> [project] [--force]
  links [--check]                 list recorded project links
  diff [skill] [--patch]          repo baseline vs live global copy (vendor skills)
  update --check                  compare installed skills against upstream (no changes)
  update [skills...] [--yes]      fetch updates via skills.sh, then review each diff
                                  and accept/reject against the vendored baseline
  vendor <skill...>               accept live copy into repo (after skills.sh update)
  restore <skill...>              reset live copy from repo baseline (reject update)
  rehash <local-skill...>         refresh manifest hashes after editing local skills
  adopt                           list host skills not yet in the repo
  adopt <skill...>|--all [--local] [--owner=<x>]
                                  import host skills into the repo (never nukes them)
  verify                          hash-check every skill against the manifest
`;

function fail(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

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

function runSync(manifest: Manifest, state: State, flags: Set<string>): void {
  const plan = planSync(manifest, state, observe(), { force: flags.has("--force") });
  for (const w of plan.warnings) console.log(c.yellow(`warn: ${w}`));
  if (flags.has("--dry-run")) {
    if (plan.actions.length === 0) console.log("nothing to do");
    for (const a of plan.actions) console.log(`would ${a.type} ${a.skill}`);
    return;
  }
  const res = apply(plan, { force: flags.has("--force") });
  for (const d of res.done) console.log(`  ${d}`);
  for (const s of res.skipped) console.log(c.yellow(`  skipped: ${s}`));
  if (res.done.length === 0 && res.skipped.length === 0) console.log("in sync; nothing to do");
}

function cmdStatus(manifest: Manifest, state: State): void {
  const obs = observe();
  const nameW = Math.max(4, ...Object.keys(manifest.skills).map((n) => n.length)) + 2;
  console.log(c.dim(`host: ${REPO}\n`));
  console.log(
    c.bold(`${pad("NAME", nameW)}${pad("ORIGIN", 8)}${pad("ENABLED", 9)}${pad("LIVE", 10)}CLAUDE`),
  );
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
      liveLabel =
        contentHash(join(AGENTS_SKILLS, name)) === meta.contentHash
          ? c.green("ok")
          : c.yellow("drift");
    } else {
      liveLabel = c.red(live.kind);
    }

    console.log(
      `${pad(name, nameW)}${pad(meta.origin, 8)}${pad(enabled ? "on" : c.dim("off"), enabled ? 9 : 9 + 9)}${pad(liveLabel, 10 + liveLabel.length - stripAnsi(liveLabel).length)}${claude}`,
    );
  }
  const foreign = Object.keys(obs.agents).filter((n) => !(n in manifest.skills));
  if (foreign.length > 0) console.log(c.yellow(`\nforeign entries in ~/.agents/skills: ${foreign.join(", ")}`));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function cmdDiff(manifest: Manifest, names: string[], patch: boolean): void {
  const targets =
    names.length > 0
      ? names
      : Object.entries(manifest.skills)
          .filter(([, m]) => m.origin === "vendor")
          .map(([n]) => n);
  let dirty = 0;
  for (const name of targets) {
    const meta = getSkill(manifest, name);
    if (!meta) fail(`unknown skill: ${name}`);
    const repoPath = join(REPO, meta.path);
    const live = join(AGENTS_SKILLS, name);
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
}

function cmdVerify(manifest: Manifest): void {
  let bad = 0;
  for (const [name, meta] of Object.entries(manifest.skills)) {
    const repoPath = join(REPO, meta.path);
    if (!existsSync(repoPath)) {
      console.log(c.red(`${name}: repo copy missing at ${meta.path}`));
      bad++;
      continue;
    }
    const h = contentHash(repoPath);
    if (h !== meta.contentHash) {
      console.log(c.yellow(`${name}: repo copy hash mismatch (manifest stale?)`));
      bad++;
    }
  }
  console.log(bad === 0 ? c.green(`all ${Object.keys(manifest.skills).length} skills verified`) : c.red(`${bad} problem(s)`));
  if (bad > 0) process.exit(1);
}

// --- repo-less commands ---------------------------------------------------

function flagValue(flagSet: Set<string>, name: string): string | undefined {
  return [...flagSet].find((f) => f.startsWith(`${name}=`))?.slice(name.length + 1);
}

function cmdInit(target: string): void {
  const dir = resolveDir(target);
  if (!isRepoDir(dir)) fail(`no skills.manifest.json in ${dir}; point init at your skills repo clone`);
  saveHostConfig(dir);
  console.log(`recorded skills repo: ${dir}\n${c.dim(`(${SLINKY_CONFIG})`)}`);
}

/** Fresh machine: clone the data repo, record it, then re-run bootstrap against it. */
function cmdCloneBootstrap(url: string, flagSet: Set<string>, extraArgs: string[]): never {
  const name = url.split("/").pop()?.replace(/\.git$/, "") || "my-agent-skills";
  const dest = resolveDir(flagValue(flagSet, "--dest") ?? join(HOME, name));
  if (isRepoDir(dest)) {
    console.log(c.dim(`${dest} already contains a skills repo; skipping clone`));
  } else {
    console.log(`cloning ${url} -> ${dest}`);
    const res = spawnSync("git", ["clone", url, dest], { stdio: "inherit" });
    if (res.status !== 0) fail("git clone failed");
  }
  saveHostConfig(dest);

  // Re-exec bootstrap; discovery now resolves via the config file.
  const passthrough = ["--adopt-all", "--no-backup", "--dry-run", "--force"].filter(
    (f) => flagSet.has(f),
  );
  const compiled = process.argv[1]?.includes("$bunfs") ?? false;
  const argv1 = process.argv[1];
  const rerun = compiled || argv1 === undefined ? [] : [argv1];
  const res = spawnSync(process.execPath, [...rerun, "bootstrap", ...passthrough, ...extraArgs], {
    stdio: "inherit",
  });
  process.exit(res.status ?? 0);
}

// --- main ---------------------------------------------------------------

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flags = new Set(rest.filter((a) => a.startsWith("-")));
const args = rest.filter((a) => !a.startsWith("-"));

const assertFlags = (allowed: ReadonlyArray<string>): void => {
  const unknown = [...flags].filter(
    (flag) => !allowed.some((option) => option.endsWith("=") ? flag.startsWith(option) : flag === option),
  );
  if (unknown.length > 0) fail(`unknown option for ${cmd ?? "tui"}: ${unknown.join(", ")}`);
};

if (cmd === "help" || cmd === "--help") {
  assertFlags([]);
  console.log(HELP);
  process.exit(0);
}
if (cmd === "init") {
  assertFlags([]);
  cmdInit(args[0] ?? process.cwd());
  process.exit(0);
}
const cloneUrl = flagValue(flags, "--clone") ?? (flags.has("--clone") ? args[0] : undefined);
if (cmd === "bootstrap" && cloneUrl) {
  assertFlags(["--clone", "--clone=", "--dest=", "--adopt-all", "--no-backup", "--dry-run", "--force"]);
  cmdCloneBootstrap(cloneUrl, flags, []);
}
if (!repoFound) {
  if (repoResolutionError) fail(repoResolutionError.message);
  fail(
    `no skills repo found. slinky looks in $SLINKY_REPO, ${SLINKY_CONFIG}, and parent dirs.\n` +
      `  existing clone:  slinky init <path-to-clone>\n` +
      `  fresh machine:   slinky bootstrap --clone=<git-url> [--dest=<path>]`,
  );
}

try {
  if (cmd === undefined || cmd === "tui") {
    const { runTui } = await import("./tui/index.tsx");
    await runTui();
  } else {
    const manifest = loadManifest();
    const state = loadState(manifest);
    await main(manifest, state);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

// eslint-disable-next-line complexity
async function main(initialManifest: Manifest, initialState: State): Promise<void> {
let manifest = initialManifest;
let state = initialState;
switch (cmd) {
  case "status":
    assertFlags([]);
    cmdStatus(manifest, state);
    break;

  case "sync":
    assertFlags(["--dry-run", "--force"]);
    runSync(manifest, state, flags);
    break;

  case "enable":
  case "disable": {
    assertFlags(["--dry-run", "--force"]);
    if (args.length === 0) fail(`usage: ${cmd} <skill...>`);
    for (const name of args) {
      if (!getSkill(manifest, name)) fail(`unknown skill: ${name}`);
      state = withSkillEnabled(state, name, cmd === "enable");
    }
    saveState(state);
    runSync(manifest, state, flags);
    break;
  }

  case "profile": {
    assertFlags(["--dry-run", "--force"]);
    const sub = args[0];
    if (sub === "list" || sub === undefined) {
      const entries = Object.entries(manifest.profiles);
      if (entries.length === 0) console.log(c.dim("no profiles defined (edit skills.manifest.json)"));
      for (const [name, skills] of entries) {
        const active = state.activeProfile === name ? c.green(" (active)") : "";
        console.log(`${c.bold(name)}${active}: ${skills.join(", ")}`);
      }
    } else if (sub === "apply") {
      const name = args[1];
      if (!name) fail("usage: profile apply <name>");
      const members = getProfile(manifest, name);
      if (!members) fail(`unknown profile: ${name}`);
      state = withProfile(manifest, state, name);
      saveState(state);
      runSync(manifest, state, flags);
    } else {
      fail("usage: profile list | profile apply <name>");
    }
    break;
  }

  case "link": {
    assertFlags(["--copy", "--symlink", "--no-exclude", "--no-claude"]);
    const [skill, projectArg] = args;
    if (!skill) fail("usage: link <skill> [project] [--copy|--symlink]  (project defaults to cwd)");
    const project = projectArg ?? process.cwd();
    if (resolveDir(project) === REPO) fail("refusing to link a skill into the skills repo itself");
    const mode = flags.has("--copy") ? "copy" : flags.has("--symlink") ? "symlink" : "copy";
    const result = linkSkill(manifest, state, {
      skill,
      project,
      mode,
      gitExclude: !flags.has("--no-exclude"),
      claude: !flags.has("--no-claude"),
    });
    state = result.state;
    try {
      saveState(state);
    } catch (error) {
      try {
        unlinkSkill(manifest, state, skill, result.link.project, { force: true });
      } catch {}
      throw error;
    }
    const link = result.link;
    console.log(`linked ${c.bold(skill)} (${mode}) into ${link.project}`);
    for (const t of link.targets) console.log(`  ${t}`);
    if (link.excludedTargets.length > 0) console.log(c.dim("  added to .git/info/exclude"));
    break;
  }

  case "unlink": {
    assertFlags(["--force"]);
    const [skill, projectArg] = args;
    if (!skill) fail("usage: unlink <skill> [project]  (project defaults to cwd)");
    const previousState = state;
    const result = prepareUnlink(manifest, state, skill, projectArg ?? process.cwd(), {
      force: flags.has("--force"),
    });
    state = result.state;
    saveState(state);
    try {
      const warnings = applyUnlink(result.link);
      for (const warning of warnings) console.log(c.yellow(`warn: ${warning}`));
    } catch (error) {
      try {
        saveState(previousState);
      } catch {}
      throw error;
    }
    const link = result.link;
    console.log(`unlinked ${c.bold(skill)} from ${link.project}`);
    break;
  }

  case "links": {
    assertFlags(["--check"]);
    if (state.projectLinks.length === 0) {
      console.log(c.dim("no project links recorded"));
      break;
    }
    for (const link of state.projectLinks) {
      const status = flags.has("--check") ? ` [${checkLink(manifest, link)}]` : "";
      console.log(`${c.bold(link.skill)} -> ${link.project} (${link.mode})${status}`);
    }
    break;
  }

  case "diff":
    assertFlags(["--patch"]);
    cmdDiff(manifest, args, flags.has("--patch"));
    break;

  case "vendor": {
    assertFlags([]);
    if (args.length === 0) fail("usage: vendor <skill...>");
    for (const name of args) {
      const result = vendorAccept(manifest, name);
      manifest = result.manifest;
      const { changed } = result;
      console.log(changed ? `${name}: vendored live copy into repo` : `${name}: already in sync`);
      if (result.warning) console.log(c.yellow(`warn: ${result.warning.message}`));
    }
    saveManifest(manifest);
    console.log(c.dim("review with `git diff` and commit to lock the new baseline"));
    break;
  }

  case "restore": {
    assertFlags([]);
    if (args.length === 0) fail("usage: restore <skill...>");
    for (const name of args) {
      vendorRestore(manifest, name);
      console.log(`${name}: live copy restored from repo baseline`);
    }
    break;
  }

  case "rehash": {
    assertFlags([]);
    if (args.length === 0) fail("usage: rehash <local-skill...>");
    let changed = false;
    for (const name of args) {
      const meta = getSkill(manifest, name);
      if (!meta) fail(`unknown skill: ${name}`);
      if (meta.origin !== "local") fail(`${name} is a vendor skill; use vendor after reviewing live drift`);
      const path = join(REPO, meta.path);
      if (!existsSync(path)) fail(`${name}: repo copy missing at ${meta.path}`);
      const hash = contentHash(path);
      if (hash === meta.contentHash) {
        console.log(`${name}: already current`);
        continue;
      }
      manifest = withManifestSkill(
        manifest,
        name,
        { ...meta, contentHash: hash },
      );
      changed = true;
      console.log(`${name}: refreshed manifest hash`);
    }
    if (changed) saveManifest(manifest);
    break;
  }

  case "bootstrap": {
    assertFlags(["--adopt-all", "--no-backup", "--dry-run", "--force"]);
    const dryRun = flags.has("--dry-run");
    console.log(c.bold("bootstrap: adopting this repo as the source of truth\n"));

    // 1. safety net
    if (!flags.has("--no-backup") && !dryRun) {
      const archive = backupGlobalDirs();
      console.log(archive ? `backup: ${archive}` : c.dim("backup: no global skill dirs yet; skipped"));
    } else {
      console.log(c.dim("backup: skipped"));
    }

    // 2. pre-existing skills on this host that the repo doesn't know
    const scan = findForeign(manifest);
    const candidates = scan.candidates;
    let stateSaved = false;
    if (scan.warning) console.log(c.yellow(`warn: ${scan.warning.message}`));
    if (candidates.length > 0) {
      if (flags.has("--adopt-all") && !dryRun) {
        const previousManifest = manifest;
        const adoptions: Adoption[] = [];
        let manifestWritten = false;
        try {
          for (const cand of candidates) {
            const result = adoptSkill(manifest, cand, {});
            adoptions.push(result);
            manifest = result.manifest;
            console.log(`adopted ${c.bold(cand.name)} -> ${result.meta.path}`);
          }
          state = alignStateWithManifest(manifest, state);
          saveManifest(manifest);
          manifestWritten = true;
          saveState(state);
        } catch (error) {
          let restored = !manifestWritten;
          if (manifestWritten) {
            try {
              saveManifest(previousManifest);
              restored = true;
            } catch {}
          }
          if (restored) for (const adoption of adoptions) rollbackAdoption(adoption);
          throw error;
        }
        for (const adoption of adoptions) finalizeAdoption(adoption);
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
    if (!dryRun && !stateSaved) saveState(state); // scaffold state when no adoption wrote it
    runSync(manifest, state, flags);

    // 4. integrity
    if (!dryRun) {
      console.log("");
      cmdVerify(manifest);
      const enabledCount = Object.keys(manifest.skills).length - state.disabledSkills.length;
      console.log(`\n${c.green("bootstrap complete")}: ${enabledCount}/${Object.keys(manifest.skills).length} skills enabled`);
      if (candidates.length > 0 && !flags.has("--adopt-all")) {
        console.log(c.yellow(`${candidates.length} foreign skill(s) pending adoption`));
      }
    }
    break;
  }

  case "adopt": {
    assertFlags(["--all", "--local", "--owner=", "--force"]);
    const scan = findForeign(manifest);
    const candidates = scan.candidates;
    if (scan.warning) console.log(c.yellow(`warn: ${scan.warning.message}`));
    if (args.length === 0 && !flags.has("--all")) {
      if (candidates.length === 0) {
        console.log(c.green("nothing to adopt; all host skills are in the repo"));
        break;
      }
      console.log(c.bold("host skills not in the repo:"));
      for (const cand of candidates) {
        const prov = cand.lock ? `from ${cand.lock.source}` : c.yellow("unknown source");
        console.log(`  ${pad(cand.name, 32)}${pad(`~/.${cand.location}`, 12)}${prov}`);
      }
      console.log(c.dim("\nadopt with: adopt <skill...> [--local] [--owner=<x>]  or  adopt --all"));
      break;
    }
    const ownerFlag = [...flags].find((f) => f.startsWith("--owner="))?.slice("--owner=".length);
    const picked = flags.has("--all")
      ? candidates
      : args.map((name) => {
          const cand = candidates.find((x) => x.name === name);
          if (!cand) fail(`no adoptable skill named ${name} (see \`adopt\` for candidates)`);
          return cand;
        });
    if (picked.length === 0) {
      console.log("nothing to adopt");
      break;
    }
    const previousManifest = manifest;
    const adoptions: Adoption[] = [];
    let manifestWritten = false;
    try {
      for (const cand of picked) {
        const result = adoptSkill(manifest, cand, {
          local: flags.has("--local"),
          ...(ownerFlag ? { owner: ownerFlag } : {}),
        });
        adoptions.push(result);
        manifest = result.manifest;
        console.log(`adopted ${c.bold(cand.name)} -> ${result.meta.path}`);
      }
      state = alignStateWithManifest(manifest, state);
      saveManifest(manifest);
      manifestWritten = true;
      saveState(state);
    } catch (error) {
      let restored = !manifestWritten;
      if (manifestWritten) {
        try {
          saveManifest(previousManifest);
          restored = true;
        } catch {}
      }
      if (restored) for (const adoption of adoptions) rollbackAdoption(adoption);
      throw error;
    }
    for (const adoption of adoptions) finalizeAdoption(adoption);
    runSync(manifest, state, flags);
    console.log(c.dim("review with `git status` and commit to lock the new baseline"));
    break;
  }

  case "update": {
    assertFlags(["--check", "--yes", "-y", "--force"]);
    if (flags.has("--check")) {
      console.log(c.dim("comparing persisted upstream hashes against GitHub\u2026"));
      const statuses = await checkUpstream(manifest);
      const label: Record<string, string> = {
        current: c.green("up to date"),
        update: c.yellow("update available"),
        gone: c.red("gone upstream (kept: vendored)"),
        unchecked: c.dim("unchecked"),
      };
      for (const s of statuses.filter((x) => x.state !== "current")) {
        console.log(`  ${pad(s.name, 32)}${label[s.state]}${s.detail ? c.dim(`  ${s.detail}`) : ""}`);
      }
      const counts = statuses.reduce<Record<string, number>>((acc, s) => {
        acc[s.state] = (acc[s.state] ?? 0) + 1;
        return acc;
      }, {});
      console.log(
        `\n${counts["update"] ?? 0} update(s), ${counts["current"] ?? 0} current, ` +
          `${counts["gone"] ?? 0} gone upstream, ${counts["unchecked"] ?? 0} unchecked`,
      );
      break;
    }

    const vendorNames = Object.entries(manifest.skills)
      .filter(([, meta]) => meta.origin === "vendor")
      .map(([name]) => name);
    const selectedNames = args.length > 0 ? args : vendorNames;
    for (const name of selectedNames) {
      const meta = getSkill(manifest, name);
      if (!meta) fail(`unknown skill: ${name}`);
      if (meta.origin !== "vendor") fail(`${name} is a local skill; it cannot be updated through skills.sh`);
    }
    if (selectedNames.length === 0) {
      console.log(c.dim("no vendor skills to update"));
      break;
    }

    // 1. preflight: the committed baseline is the snapshot we diff against
    if (baselineDirty() && !flags.has("--force")) {
      fail("vendor/skills baseline has uncommitted changes; commit or stash first (--force to override)");
    }

    // 2. fetch via skills.sh (updates live copies + lock; baselines untouched)
    console.log(c.bold("running npx skills update\u2026\n"));
    const code = runSkillsUpdate(selectedNames);
    if (code !== 0) fail(`skills.sh exited with ${code}`);

    // 3. detect what actually changed vs our baselines
    const outcome = detectChanges(manifest, state, selectedNames);
    if (outcome.changed.length === 0 && outcome.missing.length === 0) {
      console.log(c.green("\nno changes: all live copies still match the vendored baselines"));
      break;
    }

    // 4. review + decide per skill
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const name of outcome.changed) {
      const meta = getSkill(manifest, name);
      if (!meta) continue;
      const repoPath = join(REPO, meta.path);
      const live = join(AGENTS_SKILLS, name);
      const d = diffDirs(repoPath, live);
      console.log(c.bold(`\n\u2500\u2500 ${name} \u2500\u2500`));
      for (const f of d.added) console.log(c.green(`  + ${f}`));
      for (const f of d.removed) console.log(c.red(`  - ${f}`));
      for (const f of d.modified) console.log(c.yellow(`  ~ ${f}`));

      let decision = flags.has("--yes") || flags.has("-y") ? "a" : "";
      while (!["a", "r", "s"].includes(decision)) {
        decision = (prompt(`accept [a] / reject [r] / skip [s] / show diff [d] >`) ?? "s").trim().toLowerCase();
        if (decision === "d") {
          console.log(unifiedDiff(repoPath, live));
          decision = "";
        }
      }
      if (decision === "a") {
        const result = vendorAccept(manifest, name);
        manifest = result.manifest;
        if (result.warning) console.log(c.yellow(`  warn: ${result.warning.message}`));
        accepted.push(name);
        console.log(c.green(`  accepted: new baseline for ${name}`));
      } else if (decision === "r") {
        vendorRestore(manifest, name);
        rejected.push(name);
        console.log(c.yellow(`  rejected: live copy restored from baseline`));
      } else {
        console.log(c.dim("  skipped (live copy stays changed; status will show drift)"));
      }
    }
    if (accepted.length > 0) saveManifest(manifest);

    // 5. resurrect enabled skills that upstream deleted
    if (outcome.missing.length > 0) {
      console.log(c.yellow(`\ngone upstream, restoring from vendored baseline: ${outcome.missing.join(", ")}`));
      runSync(manifest, state, new Set());
    }

    console.log(
      `\n${c.bold("summary:")} ${accepted.length} accepted, ${rejected.length} rejected, ` +
        `${outcome.changed.length - accepted.length - rejected.length} skipped, ${outcome.missing.length} restored`,
    );
    if (accepted.length > 0) {
      console.log(c.dim(`review with \`git diff\` then commit to lock the new baseline`));
    }
    break;
  }

  case "verify":
    assertFlags([]);
    cmdVerify(manifest);
    break;

  default:
    fail(`unknown command: ${cmd}\n${HELP}`);
}
}
