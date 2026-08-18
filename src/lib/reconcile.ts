import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Effect, Match } from "effect";
import { isSkillEnabled } from "../domain/model.ts";
import { contentHash } from "./hash.ts";
import type { Manifest, State } from "./manifest.ts";
import { claudeRelTarget, HostRepo, Paths } from "./paths.ts";

export type LiveKind = "missing" | "symlink" | "broken-symlink" | "dir" | "file";

export interface LiveEntry {
  kind: LiveKind;
  /** Direct symlink target as an absolute path, including for broken symlinks. */
  resolved?: string;
}

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

function observeDir(dir: string): Record<string, LiveEntry> {
  const out: Record<string, LiveEntry> = Object.create(null);
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      const resolved = resolve(dir, readlinkSync(p));
      try {
        realpathSync(p);
        out[name] = { kind: "symlink", resolved };
      } catch {
        out[name] = { kind: "broken-symlink", resolved };
      }
    } else if (st.isDirectory()) {
      out[name] = { kind: "dir" };
    } else {
      out[name] = { kind: "file" };
    }
  }
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
    const enabled = isSkillEnabled(state, name);
    const live: LiveEntry = Object.hasOwn(obs.agents, name) ? obs.agents[name]! : { kind: "missing" };
    const claude: LiveEntry = Object.hasOwn(obs.claude, name) ? obs.claude[name]! : { kind: "missing" };
    const repoPath = resolve(repo, meta.path);
    const claudeTarget = resolve(claudeSkills, claudeRelTarget(name));

    if (enabled) {
      // canonical store
      if (meta.origin === "local") {
        if (live.kind === "missing" || live.kind === "broken-symlink") {
          actions.push({ type: "ensure-agents-symlink", skill: name, target: repoPath });
        } else if (live.kind === "symlink" && live.resolved !== repoPath) {
          actions.push({ type: "ensure-agents-symlink", skill: name, target: repoPath });
        } else if (live.kind === "dir" || live.kind === "file") {
          if (force) {
            actions.push({ type: "remove-agents", skill: name, verifyHash: meta.contentHash });
            actions.push({ type: "ensure-agents-symlink", skill: name, target: repoPath });
          } else {
            warnings.push(`${name}: real ${live.kind} where symlink to repo expected (use --force to replace)`);
          }
        }
      } else {
        if (live.kind === "missing" || live.kind === "broken-symlink") {
          actions.push({ type: "restore-agents-dir", skill: name, from: repoPath });
        } else if (live.kind === "symlink") {
          // normalize to a real dir so skills.sh can update in place
          actions.push({ type: "remove-agents", skill: name });
          actions.push({ type: "restore-agents-dir", skill: name, from: repoPath });
        } else if (live.kind === "file") {
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
      if (claude.kind === "missing" || claude.kind === "broken-symlink") {
        actions.push({ type: "ensure-claude-symlink", skill: name });
      } else if (claude.kind === "symlink" && claude.resolved !== claudeTarget) {
        actions.push({ type: "ensure-claude-symlink", skill: name });
      } else if (claude.kind === "dir" || claude.kind === "file") {
        if (force) {
          actions.push({ type: "remove-claude", skill: name });
          actions.push({ type: "ensure-claude-symlink", skill: name });
        } else {
          warnings.push(`${name}: real ${claude.kind} in ~/.claude/skills (use --force to replace with symlink)`);
        }
      }
    } else {
      if (claude.kind === "symlink" || claude.kind === "broken-symlink") {
        actions.push({ type: "remove-claude", skill: name });
      } else if (claude.kind === "dir" || claude.kind === "file") {
        if (force) actions.push({ type: "remove-claude", skill: name });
        else warnings.push(`${name}: real ${claude.kind} in ~/.claude/skills; not removing without --force`);
      }
      if (live.kind === "symlink" || live.kind === "broken-symlink") {
        actions.push({ type: "remove-agents", skill: name });
      } else if (live.kind === "dir") {
        actions.push({ type: "remove-agents", skill: name, verifyHash: meta.contentHash });
      } else if (live.kind === "file") {
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
      rmIfExists(agentsPath);
      symlinkSync(a.target, agentsPath);
      done.push(`linked ~/.agents/skills/${a.skill} -> ${a.target}`);
    }),
    Match.discriminator("type")("restore-agents-dir", (a) => {
      const agentsPath = join(agentsSkills, a.skill);
      rmIfExists(agentsPath);
      cpSync(a.from, agentsPath, { recursive: true });
      done.push(`restored ~/.agents/skills/${a.skill} from repo`);
    }),
    Match.discriminator("type")("ensure-claude-symlink", (a) => {
      // Skip if canonical entry was skipped (avoid creating broken links).
      if (!existsSync(join(agentsSkills, a.skill))) {
        skipped.push(`${a.skill}: skipped claude symlink (no canonical entry)`);
        return;
      }
      const claudePath = join(claudeSkills, a.skill);
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
