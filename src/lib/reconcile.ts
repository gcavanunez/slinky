import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Effect, Match } from "effect";
import type { LiveEntry } from "../domain/catalog-inspection.ts";
import { claudeRelTarget, planSync } from "../domain/reconcile-plan.ts";
import type { Action, Observation, Plan } from "../domain/reconcile-plan.ts";
import type { Manifest, State } from "../domain/model.ts";
import { contentHash } from "./hash.ts";
import { HostRepo, Paths } from "./paths.ts";

export function observeEntry(path: string): LiveEntry {
  if (!existsSync(path)) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return { kind: "broken-symlink", resolved: resolve(dirname(path), readlinkSync(path)) };
    } catch {
      return { kind: "missing" };
    }
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const resolved = resolve(dirname(path), readlinkSync(path));
    realpathSync(path);
    return { kind: "symlink", resolved };
  }
  return stat.isDirectory() ? { kind: "dir" } : { kind: "file" };
}

function observeDir(dir: string): Record<string, LiveEntry> {
  const out: Record<string, LiveEntry> = Object.create(null);
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) out[name] = observeEntry(join(dir, name));
  return out;
}

/** Observe the live global skill dirs. */
export const observe = Effect.fn("Reconcile.observe")(function* () {
  const paths = yield* Paths;
  return { agents: observeDir(paths.agentsSkills), claude: observeDir(paths.claudeSkills) } satisfies Observation;
});

export interface ApplyResult {
  done: string[];
  skipped: string[];
}

function applySync(agentsSkills: string, claudeSkills: string, plan: Plan, opts: { force?: boolean }): ApplyResult {
  const done: string[] = [];
  const skipped: string[] = [];
  mkdirSync(agentsSkills, { recursive: true });
  mkdirSync(claudeSkills, { recursive: true });

  // force: true tolerates missing paths; real removal failures surface as defects.
  const rmIfExists = (p: string) => rmSync(p, { recursive: true, force: true });
  const stillExpectedSymlink = (path: string, target: string): boolean => {
    try {
      return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === target;
    } catch {
      return false;
    }
  };
  const canReplace = (path: string, target: string): boolean => {
    if (opts.force) return true;
    const current = observeEntry(path);
    return current.kind === "missing" || ((current.kind === "symlink" || current.kind === "broken-symlink") && current.resolved === target);
  };
  const hideOwnedClaudeLink = (skill: string): void => {
    const path = join(claudeSkills, skill);
    const target = resolve(claudeSkills, claudeRelTarget(skill));
    if (!stillExpectedSymlink(path, target)) return;
    rmIfExists(path);
    done.push(`removed ~/.claude/skills/${skill} after canonical replacement was refused`);
  };

  const applyAction = Match.type<Action>().pipe(
    Match.discriminator("type")("remove-claude", (a) => {
      const claudePath = join(claudeSkills, a.skill);
      if (skipped.some((message) => message.startsWith(`${a.skill}:`))) {
        skipped.push(`${a.skill}: skipped claude removal after canonical removal was refused`);
        return;
      }
      if (a.expectedTarget && !stillExpectedSymlink(claudePath, a.expectedTarget) && !opts.force) {
        skipped.push(`${a.skill}: claude symlink changed after preflight; not removing`);
        return;
      }
      rmIfExists(claudePath);
      done.push(`removed ~/.claude/skills/${a.skill}`);
    }),
    Match.discriminator("type")("remove-agents", (a) => {
      const agentsPath = join(agentsSkills, a.skill);
      if (a.expectedTarget && !stillExpectedSymlink(agentsPath, a.expectedTarget) && !opts.force) {
        skipped.push(`${a.skill}: agents symlink changed after preflight; not removing`);
        return;
      }
      if (a.verifyHash && !opts.force) {
        if (!existsSync(agentsPath)) return;
        const stat = lstatSync(agentsPath);
        if (!stat.isDirectory() || stat.isSymbolicLink() || contentHash(agentsPath) !== a.verifyHash) {
          skipped.push(`${a.skill}: live dir drifted from repo copy; run \`diff ${a.skill}\` then \`vendor ${a.skill}\` or use --force`);
          return;
        }
      }
      rmIfExists(agentsPath);
      done.push(`removed ~/.agents/skills/${a.skill}`);
    }),
    Match.discriminator("type")("ensure-agents-symlink", (a) => {
      const agentsPath = join(agentsSkills, a.skill);
      if (!canReplace(agentsPath, a.target)) {
        skipped.push(`${a.skill}: agents path changed after preflight; not replacing`);
        hideOwnedClaudeLink(a.skill);
        return;
      }
      rmIfExists(agentsPath);
      symlinkSync(a.target, agentsPath);
      done.push(`linked ~/.agents/skills/${a.skill} -> ${a.target}`);
    }),
    Match.discriminator("type")("restore-agents-dir", (a) => {
      const agentsPath = join(agentsSkills, a.skill);
      if (skipped.some((message) => message.startsWith(`${a.skill}:`))) {
        skipped.push(`${a.skill}: skipped restore after canonical removal was refused`);
        return;
      }
      if (!canReplace(agentsPath, a.from)) {
        skipped.push(`${a.skill}: agents path changed after preflight; not replacing`);
        hideOwnedClaudeLink(a.skill);
        return;
      }
      rmIfExists(agentsPath);
      cpSync(a.from, agentsPath, { recursive: true });
      done.push(`restored ~/.agents/skills/${a.skill} from repo`);
    }),
    Match.discriminator("type")("ensure-claude-symlink", (a) => {
      // Skip if canonical entry was skipped (avoid creating broken links).
      if (skipped.some((message) => message.startsWith(`${a.skill}:`))) {
        skipped.push(`${a.skill}: skipped claude symlink after canonical replacement was refused`);
        return;
      }
      if (!existsSync(join(agentsSkills, a.skill))) {
        skipped.push(`${a.skill}: skipped claude symlink (no canonical entry)`);
        return;
      }
      const claudePath = join(claudeSkills, a.skill);
      const target = resolve(claudeSkills, claudeRelTarget(a.skill));
      if (!canReplace(claudePath, target)) {
        skipped.push(`${a.skill}: claude path changed after preflight; not replacing`);
        return;
      }
      rmIfExists(claudePath);
      symlinkSync(claudeRelTarget(a.skill), claudePath);
      done.push(`linked ~/.claude/skills/${a.skill}`);
    }),
    Match.exhaustive,
  );

  for (const a of plan.actions) applyAction(a);
  return { done, skipped };
}

/** Execute a plan against the live global dirs. */
export const apply = Effect.fn("Reconcile.apply")(function* (plan: Plan, opts: { force?: boolean } = {}) {
  const paths = yield* Paths;
  return yield* Effect.sync(() => applySync(paths.agentsSkills, paths.claudeSkills, plan, opts));
});

/** Observe the live dirs and plan a sync without applying it. */
export const observeAndPlan = Effect.fn("Reconcile.observeAndPlan")(function* (manifest: Manifest, state: State, opts: { force?: boolean } = {}) {
  const paths = yield* Paths;
  const host = yield* HostRepo;
  const obs = yield* observe();
  return planSync(manifest, state, obs, { repo: host.repo, claudeSkills: paths.claudeSkills, ...opts });
});

export interface ReconcileOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

/** Plan and, unless dry-running, apply one catalog reconciliation. */
export const reconcileCatalog = Effect.fn("Reconcile.catalog")(function* (manifest: Manifest, state: State, options: ReconcileOptions = {}) {
  const plan = yield* observeAndPlan(manifest, state, { force: options.force ?? false });
  const applied = options.dryRun ? null : yield* apply(plan, { force: options.force ?? false });
  return { plan, applied };
});
