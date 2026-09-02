import { Effect } from "effect";
import { OperationFailed } from "../domain/model.ts";
import { adoptSkills, findStaged } from "./adopt.ts";
import type { UnindexedSkill } from "./adopt.ts";
import { getSkill, ManifestStore } from "./manifest.ts";
import { HostRepo } from "./paths.ts";
import { reconcileCatalog } from "./reconcile.ts";
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
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  if (getSkill(manifest, name)) return yield* Effect.fail(new OperationFailed({ message: `${name} is already indexed in skills.manifest.json` }));

  yield* runSkillsAdd(source, [name], repo);

  const scan = yield* findStaged(manifest);
  const entry = scan.staged.find((item) => item.candidate.name === name);
  if (!entry) return yield* Effect.fail(new OperationFailed({ message: `${name} was not found in .agents/skills after installation` }));
  const unindexed = options.unindexedSkill;
  const request = unindexed === undefined ? { candidate: entry.candidate } : { candidate: entry.candidate, unindexedSkill: unindexed };
  const adoption = yield* adoptSkills(store, manifest, state, [request]);
  const adopted = adoption.adopted[0];
  if (!adopted) return yield* Effect.fail(new OperationFailed({ message: `${name} was not adopted` }));

  const replaceLocalGlobalCopy = unindexed?.origin === "local";
  const reconciliation = yield* reconcileCatalog(adoption.manifest, adoption.state, { force: replaceLocalGlobalCopy });
  const { plan, applied } = reconciliation;
  if (!applied) return yield* Effect.fail(new OperationFailed({ message: `${name} was not reconciled` }));
  const warnings = [...(scan.warning ? [scan.warning.message] : []), ...adoption.warnings, ...plan.warnings, ...applied.skipped];

  return { name, path: adopted.path, messages: applied.done, warnings } satisfies SkillsAddResult;
});
