import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { Manifest } from "../domain/model.ts";
import { adoptSkills, clearStagingResidue, findForeign, findStaged } from "../lib/adopt.ts";
import type { AdoptOptions, ForeignSkill } from "../lib/adopt.ts";
import { errorDetail } from "../domain/model.ts";
import { contentHash } from "../lib/hash.ts";
import { HostRepo } from "../lib/paths.ts";
import { runSkillsAdd } from "../lib/update.ts";
import { c, pad, renderAdoptions } from "./render.ts";
import { bail, forceFlag, loadHostState, runSyncCmd, withRepo } from "./shared.ts";

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
    try {
      rmSync(entry.dir, { recursive: true, force: true });
    } catch (error) {
      console.log(c.yellow(`warn: ${entry.name}: could not remove redundant staging copy ${entry.dir}: ${errorDetail(error)}`));
      continue;
    }
    for (const warning of yield* clearStagingResidue(entry.name)) console.log(c.yellow(`warn: ${warning}`));
    console.log(c.dim(`  ${entry.name}: already indexed at ${entry.path}; removed the redundant staging copy`));
  }
});

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
        if (picked.length === 0) {
          yield* dropRedundantStaging(pool);
          if (pool.redundant.length === 0) console.log("nothing new to index");
          return;
        }

        const adopted = yield* adoptSkills(
          store,
          manifest,
          state,
          picked.map((candidate) => ({ candidate })),
        );
        manifest = adopted.manifest;
        state = adopted.state;
        renderAdoptions(adopted);
        yield* dropRedundantStaging(pool);
        yield* runSyncCmd(manifest, state, {});
        yield* suggestStagingIgnore();
        console.log(c.dim("review with `git status` and commit to lock the new baseline"));
      }),
    ),
).pipe(Command.withDescription("Install with skills.sh into the repo, then vendor, index, and sync"));

export const skillsCommand = Command.make("skills").pipe(Command.withDescription("skills.sh integration"), Command.withSubcommands([skillsAddCommand]));

export const adoptCommand = Command.make(
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
        if (picked.length === 0) {
          if (adoptAll) yield* dropRedundantStaging(pool);
          if (pool.redundant.length === 0) console.log("nothing to adopt");
          return;
        }
        const options: AdoptOptions = Option.isSome(input.owner) ? { local: input.local, owner: input.owner.value } : { local: input.local };
        const adopted = yield* adoptSkills(
          store,
          manifest,
          state,
          picked.map((candidate) => ({ candidate, options })),
        );
        manifest = adopted.manifest;
        state = adopted.state;
        renderAdoptions(adopted);
        if (adoptAll) yield* dropRedundantStaging(pool);
        yield* runSyncCmd(manifest, state, { force: input.force });
        yield* suggestStagingIgnore();
        console.log(c.dim("review with `git status` and commit to lock the new baseline"));
      }),
    ),
).pipe(Command.withDescription("List staged and host skills not yet in the repo, or import them (never nukes them)"));
