import { join, resolve } from "node:path";
import { classifyPlacement } from "./catalog-inspection.ts";
import type { LiveEntry } from "./catalog-inspection.ts";
import { isSkillEnabled } from "./model.ts";
import type { Manifest, State } from "./model.ts";

/** Relative target for a `~/.claude/skills/<name>` visibility symlink. */
export const claudeRelTarget = (name: string) => join("..", "..", ".agents", "skills", name);

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
