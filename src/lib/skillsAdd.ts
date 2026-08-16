import { rmSync } from "node:fs";
import { Effect, Schema } from "effect";
import { errorDetail, formatUtc, nowUtc, OperationFailed, Skill, withManifestSkill } from "../domain/model.ts";
import { adoptSkill, backfillTreeHash, clearStagingResidue, finalizeAdoption, findStaged, rollbackAdoption, upstreamFromLock } from "./adopt.ts";
import type { Adoption, UnindexedSkill } from "./adopt.ts";
import { contentHash } from "./hash.ts";
import { alignStateWithManifest, getSkill, ManifestStore } from "./manifest.ts";
import { HostRepo } from "./paths.ts";
import { apply, observeAndPlan } from "./reconcile.ts";
import { runSkillsAdd } from "./update.ts";

export interface SkillsAddResult {
  readonly name: string;
  readonly path: string;
  readonly messages: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

export interface SkillsAddOptions {
  readonly inheritStdio?: boolean;
  /** Existing host entry to index after verifying it matches the upstream installation. */
  readonly unindexedSkill?: UnindexedSkill;
}

const decodeSkill = Schema.decodeUnknownSync(Skill);

/** Accept a source alone or a pasted skills.sh/Slinky add command for the selected skill. */
export function parseSkillsAddSource(input: string, expectedName: string): string {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 1) return tokens[0]!;

  let index = 0;
  if (tokens[index] === "npx") {
    index++;
    if (tokens[index] === "-y" || tokens[index] === "--yes") index++;
  } else if (tokens[index] === "slinky") {
    index++;
  }
  if (tokens[index] !== "skills" || tokens[index + 1] !== "add" || !tokens[index + 2]) {
    throw new OperationFailed({ message: `enter a source or \`skills add <source> --skill ${expectedName}\`` });
  }
  const source = tokens[index + 2]!;
  index += 3;

  let name: string | undefined;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--skill") {
      name = tokens[index + 1];
      index += 2;
    } else if (token.startsWith("--skill=")) {
      name = token.slice("--skill=".length);
      index++;
    } else if (["--global", "-g", "--yes", "-y"].includes(token)) {
      index++;
    } else {
      throw new OperationFailed({ message: `unsupported add argument: ${token}` });
    }
  }
  if (name !== expectedName) throw new OperationFailed({ message: `command must select --skill ${expectedName}` });
  return source;
}

/** Install one named skill into the repo staging inbox, index it, persist, and reconcile. */
export const addSkillFromSource = Effect.fn("SkillsAdd.addSkillFromSource")(function* (source: string, name: string, options: SkillsAddOptions = {}) {
  const store = yield* ManifestStore;
  const { repo } = yield* HostRepo;
  let manifest = yield* store.loadManifest();
  let state = yield* store.loadState(manifest);
  if (getSkill(manifest, name)) return yield* Effect.fail(new OperationFailed({ message: `${name} is already indexed in skills.manifest.json` }));

  yield* runSkillsAdd(source, [name], repo);

  const scan = yield* findStaged(manifest);
  const entry = scan.staged.find((item) => item.candidate.name === name);
  if (!entry) return yield* Effect.fail(new OperationFailed({ message: `${name} was not found in .agents/skills after installation` }));
  // Project locks omit the git tree SHA; recover it so `update --check` still works.
  const lockMeta = entry.candidate.lock ? yield* backfillTreeHash(entry.candidate.lock) : undefined;
  const candidate = lockMeta === undefined ? entry.candidate : { ...entry.candidate, lock: lockMeta };
  const unindexed = options.unindexedSkill;
  if (unindexed && unindexed.name !== name) {
    return yield* Effect.fail(new OperationFailed({ message: `unindexed skill ${unindexed.name} does not match ${name}` }));
  }
  if (unindexed && contentHash(unindexed.dir) !== contentHash(candidate.dir)) {
    return yield* Effect.fail(new OperationFailed({ message: `${name}: installed content differs from the unindexed host copy; both were left for review` }));
  }

  const previousManifest = manifest;
  let adoption: Adoption | undefined;
  let path: string;
  if (unindexed?.origin === "local" || unindexed?.origin === "vendor") {
    const meta = decodeSkill(
      unindexed.origin === "local"
        ? { origin: "local", path: unindexed.path, contentHash: contentHash(unindexed.dir) }
        : {
            origin: "vendor",
            path: unindexed.path,
            contentHash: contentHash(unindexed.dir),
            upstream: upstreamFromLock(candidate.lock),
            vendoredAt: formatUtc(nowUtc()),
          },
    );
    manifest = withManifestSkill(manifest, name, meta);
    path = meta.path;
  } else {
    adoption = yield* adoptSkill(manifest, candidate);
    manifest = adoption.manifest;
    path = adoption.meta.path;
  }

  let manifestWritten = false;
  yield* Effect.gen(function* () {
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
        if (restored && adoption) rollbackAdoption(adoption);
      }),
    ),
  );
  if (adoption) finalizeAdoption(adoption);

  const replaceLocalGlobalCopy = unindexed?.origin === "local";
  const plan = yield* observeAndPlan(manifest, state, { force: replaceLocalGlobalCopy });
  const applied = yield* apply(plan, { force: replaceLocalGlobalCopy });
  const warnings = [...(scan.warning ? [scan.warning.message] : []), ...plan.warnings, ...applied.skipped];

  // Adoption moves the staging dir out; indexing in place leaves a duplicate behind.
  if (!adoption) {
    try {
      rmSync(candidate.dir, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`indexed, but could not remove ${candidate.dir}: ${errorDetail(error)}`);
    }
  }
  warnings.push(...(yield* clearStagingResidue(name)));

  return { name, path, messages: applied.done, warnings } satisfies SkillsAddResult;
});
