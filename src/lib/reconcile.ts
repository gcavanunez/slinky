import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Effect, Match } from "effect";
import { isSkillEnabled } from "../domain/model.ts";
import { classifyPlacement } from "./catalogInspection.ts";
import type { LiveEntry } from "./catalogInspection.ts";
import { contentHash } from "./hash.ts";
import type { Manifest, State } from "./manifest.ts";
import { claudeRelTarget, HostRepo, Paths } from "./paths.ts";

export type { LiveEntry, LiveKind } from "./catalogInspection.ts";

export interface Observation {
  agents: Record<string, LiveEntry>;
  claude: Record<string, LiveEntry>;
}

export type Action =
  | { type: "ensure-agents-symlink"; skill: string; target: string }
  | { type: "restore-agents-dir"; skill: string; from: string }
  | { type: "remove-agents"; skill: string; verifyHash?: string; expectedTarget?: string }
  | { type: "ensure-claude-symlink"; skill: string }
  | { type: "remove-claude"; skill: string; expectedTarget?: string };

export interface Plan {
  actions: Action[];
  warnings: string[];
}

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

export interface PlanOptions {
  /** Repo root the plan should link against. */
  readonly repo: string;
  /** ~/.claude/skills dir used to resolve expected claude symlink targets. */
  readonly claudeSkills?: string;
  readonly force?: boolean;
}

/**
 * Pure planner: given manifest + enabled state + observed filesystem, compute
 * the actions needed to reconcile the global dirs.
 *
 * Desired state:
 * - enabled local skill:  ~/.agents/skills/<n> is a symlink -> <repo>/skills/<n>
 * - enabled vendor skill: ~/.agents/skills/<n> is a real dir (skills.sh compatible)
 * - any enabled skill:    ~/.claude/skills/<n> is a symlink -> ../../.agents/skills/<n>
 * - disabled skill:       absent from both dirs (repo retains the content)
 */
export function planSync(manifest: Manifest, state: State, obs: Observation, opts: PlanOptions): Plan {
  const repo = opts.repo;
  const claudeSkills = opts.claudeSkills ?? "";
  const force = opts.force ?? false;
  const actions: Action[] = [];
  const warnings: string[] = [];

  for (const [name, meta] of Object.entries(manifest.skills)) {
    const enabled = isSkillEnabled(manifest, state, name);
    const live: LiveEntry = Object.hasOwn(obs.agents, name) ? obs.agents[name]! : { kind: "missing" };
    const claude: LiveEntry = Object.hasOwn(obs.claude, name) ? obs.claude[name]! : { kind: "missing" };
    const repoPath = resolve(repo, meta.path);
    const claudeTarget = resolve(claudeSkills, claudeRelTarget(name));
    const placement = classifyPlacement(live, repoPath);
    const claudePlacement = classifyPlacement(claude, claudeTarget);

    if (enabled) {
      // canonical store
      if (meta.origin === "local") {
        if (placement === "missing" || placement === "broken-symlink") {
          actions.push({ type: "ensure-agents-symlink", skill: name, target: repoPath });
        } else if (placement === "wrong-symlink") {
          if (force) actions.push({ type: "ensure-agents-symlink", skill: name, target: repoPath });
          else {
            warnings.push(`${name}: symlink points outside the catalog (use --force to replace)`);
            continue;
          }
        } else if (placement === "dir" || placement === "file") {
          if (force) {
            actions.push({ type: "remove-agents", skill: name, verifyHash: meta.contentHash });
            actions.push({ type: "ensure-agents-symlink", skill: name, target: repoPath });
          } else {
            warnings.push(`${name}: real ${live.kind} where symlink to repo expected (use --force to replace)`);
            continue;
          }
        }
      } else {
        if (placement === "missing" || placement === "broken-symlink") {
          actions.push({ type: "restore-agents-dir", skill: name, from: repoPath });
        } else if (placement === "expected-symlink") {
          // normalize to a real dir so skills.sh can update in place
          actions.push({ type: "remove-agents", skill: name, expectedTarget: live.kind === "symlink" ? live.resolved : repoPath });
          actions.push({ type: "restore-agents-dir", skill: name, from: repoPath });
        } else if (placement === "wrong-symlink") {
          if (force) {
            actions.push({ type: "remove-agents", skill: name });
            actions.push({ type: "restore-agents-dir", skill: name, from: repoPath });
          } else {
            warnings.push(`${name}: symlink points outside the catalog (use --force to replace)`);
            continue;
          }
        } else if (placement === "file") {
          if (force) {
            actions.push({ type: "remove-agents", skill: name });
            actions.push({ type: "restore-agents-dir", skill: name, from: repoPath });
          } else {
            warnings.push(`${name}: plain file where vendor directory expected (use --force to replace)`);
            continue;
          }
        }
        // dir: leave as-is; drift is surfaced by `status`/`diff`, not sync
      }
      // claude visibility
      if (claudePlacement === "missing" || claudePlacement === "broken-symlink") {
        actions.push({ type: "ensure-claude-symlink", skill: name });
      } else if (claudePlacement === "wrong-symlink") {
        if (force) actions.push({ type: "ensure-claude-symlink", skill: name });
        else warnings.push(`${name}: claude symlink points outside the catalog (use --force to replace)`);
      } else if (claudePlacement === "dir" || claudePlacement === "file") {
        if (force) {
          actions.push({ type: "remove-claude", skill: name });
          actions.push({ type: "ensure-claude-symlink", skill: name });
        } else {
          warnings.push(`${name}: real ${claude.kind} in ~/.claude/skills (use --force to replace with symlink)`);
        }
      }
    } else {
      if (claudePlacement === "expected-symlink" || claudePlacement === "broken-symlink") {
        actions.push({ type: "remove-claude", skill: name, expectedTarget: claude.kind === "symlink" || claude.kind === "broken-symlink" ? claude.resolved : claudeTarget });
      } else if (claudePlacement === "wrong-symlink") {
        if (force) actions.push({ type: "remove-claude", skill: name });
        else warnings.push(`${name}: claude symlink points outside the catalog; not removing without --force`);
      } else if (claudePlacement === "dir" || claudePlacement === "file") {
        if (force) actions.push({ type: "remove-claude", skill: name });
        else warnings.push(`${name}: real ${claude.kind} in ~/.claude/skills; not removing without --force`);
      }
      if (placement === "expected-symlink" || placement === "broken-symlink") {
        actions.push({ type: "remove-agents", skill: name, expectedTarget: live.kind === "symlink" || live.kind === "broken-symlink" ? live.resolved : repoPath });
      } else if (placement === "wrong-symlink") {
        if (force) actions.push({ type: "remove-agents", skill: name });
        else warnings.push(`${name}: symlink points outside the catalog; not removing without --force`);
      } else if (placement === "dir") {
        if (meta.origin === "vendor") actions.push({ type: "remove-agents", skill: name, verifyHash: meta.contentHash });
        else if (force) actions.push({ type: "remove-agents", skill: name });
        else warnings.push(`${name}: real directory replaced the catalog symlink; not removing without --force`);
      } else if (placement === "file") {
        if (force) actions.push({ type: "remove-agents", skill: name });
        else warnings.push(`${name}: unexpected plain file in ~/.agents/skills; not touching it without --force`);
      }
    }
  }

  for (const name of Object.keys(obs.agents)) {
    if (!Object.hasOwn(manifest.skills, name)) {
      warnings.push(`${name}: present in ~/.agents/skills but not in manifest (foreign; ignored)`);
    }
  }

  const order = {
    "remove-claude": 0,
    "remove-agents": 1,
    "ensure-agents-symlink": 2,
    "restore-agents-dir": 3,
    "ensure-claude-symlink": 4,
  } satisfies Record<Action["type"], number>;
  actions.sort((a, b) => order[a.type] - order[b.type]);
  return { actions, warnings };
}

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
