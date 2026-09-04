import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { classifyPlacement } from "../domain/catalog-inspection.ts";
import { compareWithUpstream } from "../lib/git.ts";
import { getSkill } from "../domain/model.ts";
import type { Manifest } from "../domain/model.ts";
import { acceptVendorDrifts, restoreVendorDrift } from "../lib/catalog-actions.ts";
import { diffDirs, isClean } from "../lib/diff.ts";
import type { DiffPager } from "../lib/diff.ts";
import { HostRepo, Paths } from "../lib/paths.ts";
import { observeEntry } from "../lib/reconcile.ts";
import { refreshLocalHashes } from "../lib/rehash.ts";
import { ensureHostSkillLock, seedGlobalSkillLock } from "../lib/skill-lock.ts";
import { assertVendorUpdatePlacements, findDriftingVendors, vendorRestore } from "../lib/vendor-ops.ts";
import { baselineDirty, checkUpstream, detectChanges, runSkillsUpdate } from "../lib/update.ts";
import { c, pad } from "./render.ts";
import { bail, forceFlag, loadHostState, openPager, optionalSkillsArg, pagerFlags, renderPatch, selectPager, skillsArg, runSyncCmd, withRepo, switchFlag } from "./shared.ts";

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
    const placement = classifyPlacement(observeEntry(live), resolve(repo, meta.path));
    if (placement === "wrong-symlink" || placement === "file") {
      console.log(`${name}: ${c.yellow("live path is not owned by this catalog")}`);
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

export const diffCommand = Command.make(
  "diff",
  {
    names: Argument.string("skill").pipe(Argument.variadic()),
    patch: switchFlag("patch", "Print the full unified diff"),
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

export const vendorCommand = Command.make("vendor", { names: skillsArg }, ({ names }) =>
  withRepo(
    Effect.gen(function* () {
      const result = yield* acceptVendorDrifts(names);
      for (const accepted of result.accepted) {
        console.log(accepted.changed ? `${accepted.name}: vendored live copy into repo` : `${accepted.name}: already in sync`);
        if (accepted.warning) console.log(c.yellow(`warn: ${accepted.warning.message}`));
      }
      for (const warning of result.warnings) {
        console.log(c.yellow(`warn: ${warning}`));
      }
      console.log(c.dim("review with `git diff` and commit to lock the new baseline"));
    }),
  ),
).pipe(Command.withDescription("Accept live copy into repo (after skills.sh update)"));

export const restoreCommand = Command.make("restore", { names: skillsArg }, ({ names }) =>
  withRepo(
    Effect.gen(function* () {
      const restoreAll = names.length === 1 && names[0] === "all";
      if (!restoreAll && names.includes("all")) return yield* bail("restore all cannot be combined with skill names");
      const { manifest } = yield* loadHostState;
      const targets = restoreAll ? yield* findDriftingVendors(manifest) : names;
      for (const name of targets) {
        yield* restoreVendorDrift(name);
        console.log(`${name}: live copy restored from repo baseline`);
      }
      if (restoreAll && targets.length === 0) console.log("all live vendor skills already match the catalog");
    }),
  ),
).pipe(Command.withDescription("Reset selected live copies, or all drift with `restore all`, from the repo baseline"));

export const rehashCommand = Command.make("rehash", { names: optionalSkillsArg }, ({ names }) =>
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

export const updateCommand = Command.make(
  "update",
  {
    names: Argument.string("skill").pipe(Argument.variadic()),
    check: switchFlag("check", "Compare installed skills against upstream (no changes)"),
    yes: switchFlag("yes", "Accept every changed skill without prompting").pipe(Flag.withAlias("y")),
    force: forceFlag,
    ...pagerFlags,
  },
  (input) =>
    withRepo(
      Effect.gen(function* () {
        const paths = yield* Paths;
        const { repo } = yield* HostRepo;
        const { manifest: initial, state } = yield* loadHostState;
        let manifest = initial;

        // The store itself may have moved: a teammate's save that this machine
        // has not pulled yet. Say so before touching vendor skills on a stale base.
        const store = yield* compareWithUpstream(repo);
        const storeBehind = store.kind === "compared" && store.behind > 0;
        if (store.kind === "unreachable") console.log(c.yellow(`could not reach ${store.upstream} to check for catalog changes: ${store.detail}`));

        if (input.check) {
          if (storeBehind) console.log(c.yellow(`catalog store is ${store.behind} commit(s) behind ${store.upstream}; run \`slinky sync\` to bring them down`));
          else if (store.kind === "compared") console.log(c.dim(`catalog store is up to date with ${store.upstream}`));
          console.log(c.dim("comparing persisted upstream hashes against GitHub…"));
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
        if (storeBehind && !input.force) {
          return yield* bail(`catalog store is ${store.behind} commit(s) behind ${store.upstream}; run \`slinky sync\` first (--force to override)`);
        }
        const hostLock = yield* ensureHostSkillLock(manifest);
        if (hostLock.changed && !input.force) {
          return yield* bail("created or refreshed .skill-lock.json; review it and run `slinky save` before updating (--force to override)");
        }
        if ((yield* baselineDirty()) && !input.force) {
          return yield* bail("catalog baseline has uncommitted changes; commit or stash first (--force to override)");
        }

        // 2. fetch via skills.sh (updates live copies + lock; baselines untouched)
        yield* assertVendorUpdatePlacements(manifest, selectedNames, input.force);
        console.log(c.bold("running npx skills update…\n"));
        yield* runSkillsUpdate(manifest, selectedNames);

        // 3. detect what actually changed vs our baselines
        const outcome = yield* detectChanges(manifest, state, selectedNames);
        if (outcome.unowned.length > 0) console.log(c.yellow(`\nunowned live placements left untouched: ${outcome.unowned.join(", ")}`));
        if (outcome.changed.length === 0 && outcome.missing.length === 0) {
          if (outcome.unowned.length === 0) console.log(c.green("\nno changes: all live copies still match the vendored baselines"));
          return;
        }

        // 4. review: one aggregate session over every change, then decide per skill
        const pager = yield* selectPager(input);
        const pathsFor = (name: string) => {
          const meta = getSkill(manifest, name);
          const live = join(paths.agentsSkills, name);
          return meta && observeEntry(live).kind === "dir" ? { repoPath: join(repo, meta.path), live } : undefined;
        };
        if (pager && !input.yes) {
          const patches: string[] = [];
          for (const name of outcome.changed) {
            const target = pathsFor(name);
            if (target) patches.push(yield* renderPatch(target.repoPath, target.live));
          }
          if (patches.length > 0) {
            console.log(c.dim(`\nreviewing ${outcome.changed.length} changed skill(s) in ${pager}…`));
            yield* openPager(patches.join("\n"), pager);
          }
        }

        const accepted: string[] = [];
        const rejected: string[] = [];
        for (const name of outcome.changed) {
          const target = pathsFor(name);
          if (!target) {
            console.log(c.yellow(`\n${name}: live path changed after update; left untouched`));
            continue;
          }
          const { repoPath, live } = target;
          const d = diffDirs(repoPath, live);
          console.log(c.bold(`\n── ${name} ──`));
          for (const f of d.added) console.log(c.green(`  + ${f}`));
          for (const f of d.removed) console.log(c.red(`  - ${f}`));
          for (const f of d.modified) console.log(c.yellow(`  ~ ${f}`));

          let decision = input.yes ? "a" : "";
          while (!["a", "r", "s"].includes(decision)) {
            decision = (prompt(`accept [a] / reject [r] / skip [s] / show diff [d] >`) ?? "s").trim().toLowerCase();
            if (decision === "d") {
              if (!pathsFor(name)) {
                console.log(c.yellow(`${name}: live path changed; refusing to read it`));
                decision = "s";
                continue;
              }
              const rendered = yield* renderPatch(repoPath, live);
              if (pager) yield* openPager(rendered, pager);
              else console.log(rendered);
              decision = "";
            }
          }
          if (decision === "a") {
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
          const acceptance = yield* acceptVendorDrifts(accepted, { refreshProvenance: true, absorbProvenance: true });
          manifest = acceptance.manifest;
          for (const result of acceptance.accepted) if (result.warning) console.log(c.yellow(`  warn: ${result.warning.message}`));
          for (const warning of acceptance.warnings) console.log(c.yellow(`  warn: ${warning}`));
        }
        yield* seedGlobalSkillLock(
          manifest,
          selectedNames.filter((name) => !outcome.unowned.includes(name)),
        );

        // 5. resurrect enabled skills that upstream deleted
        if (outcome.missing.length > 0) {
          console.log(c.yellow(`\ngone upstream, restoring from vendored baseline: ${outcome.missing.join(", ")}`));
          yield* runSyncCmd(manifest, state, {});
        }

        console.log(
          `\n${c.bold("summary:")} ${accepted.length} accepted, ${rejected.length} rejected, ` +
            `${outcome.changed.length - accepted.length - rejected.length} skipped, ${outcome.missing.length} restored, ${outcome.unowned.length} unowned`,
        );
        if (accepted.length > 0) {
          console.log(c.dim(`review with \`git diff\` then commit to lock the new baseline`));
        }
      }),
    ),
).pipe(Command.withDescription("Check upstream (--check) or fetch updates via skills.sh and review each diff"));
