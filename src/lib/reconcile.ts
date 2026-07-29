import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { isSkillEnabled } from "../domain/model.ts";
import { contentHash } from "./hash.ts";
import type { Manifest, State } from "./manifest.ts";
import { AGENTS_SKILLS, CLAUDE_SKILLS, claudeRelTarget, REPO } from "./paths.ts";

export type LiveKind = "missing" | "symlink" | "broken-symlink" | "dir" | "file";

export interface LiveEntry {
  kind: LiveKind;
  /** Fully resolved symlink target (absolute), when kind === "symlink". */
  resolved?: string;
}

export interface Observation {
  agents: Record<string, LiveEntry>;
  claude: Record<string, LiveEntry>;
}

export type Action =
  | { type: "ensure-agents-symlink"; skill: string; target: string }
  | { type: "restore-agents-dir"; skill: string; from: string }
  | { type: "remove-agents"; skill: string; verifyHash?: string }
  | { type: "ensure-claude-symlink"; skill: string }
  | { type: "remove-claude"; skill: string };

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
      try {
        out[name] = { kind: "symlink", resolved: realpathSync(p) };
      } catch {
        out[name] = { kind: "broken-symlink" };
      }
    } else if (st.isDirectory()) {
      out[name] = { kind: "dir" };
    } else {
      out[name] = { kind: "file" };
    }
  }
  return out;
}

export function observe(): Observation {
  return { agents: observeDir(AGENTS_SKILLS), claude: observeDir(CLAUDE_SKILLS) };
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
export function planSync(manifest: Manifest, state: State, obs: Observation, opts: { force?: boolean; repo?: string } = {}): Plan {
  const repo = opts.repo ?? REPO;
  const force = opts.force ?? false;
  const actions: Action[] = [];
  const warnings: string[] = [];

  for (const [name, meta] of Object.entries(manifest.skills)) {
    const enabled = isSkillEnabled(state, name);
    const live: LiveEntry = Object.hasOwn(obs.agents, name) ? obs.agents[name]! : { kind: "missing" };
    const claude: LiveEntry = Object.hasOwn(obs.claude, name) ? obs.claude[name]! : { kind: "missing" };
    const repoPath = resolve(repo, meta.path);
    const claudeTarget = resolve(CLAUDE_SKILLS, claudeRelTarget(name));

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
        warnings.push(`${name}: unexpected plain file in ~/.agents/skills; not touching it`);
      }
    }
  }

  for (const name of Object.keys(obs.agents)) {
    if (!Object.hasOwn(manifest.skills, name)) {
      warnings.push(`${name}: present in ~/.agents/skills but not in manifest (foreign; ignored)`);
    }
  }

  const order: Record<Action["type"], number> = {
    "remove-claude": 0,
    "remove-agents": 1,
    "ensure-agents-symlink": 2,
    "restore-agents-dir": 3,
    "ensure-claude-symlink": 4,
  };
  actions.sort((a, b) => order[a.type] - order[b.type]);
  return { actions, warnings };
}

export interface ApplyResult {
  done: string[];
  skipped: string[];
}

export function apply(plan: Plan, opts: { force?: boolean } = {}): ApplyResult {
  const done: string[] = [];
  const skipped: string[] = [];
  mkdirSync(AGENTS_SKILLS, { recursive: true });
  mkdirSync(CLAUDE_SKILLS, { recursive: true });

  const rmIfExists = (p: string) => {
    try {
      lstatSync(p);
      rmSync(p, { recursive: true, force: true });
    } catch {}
  };

  for (const a of plan.actions) {
    const agentsPath = join(AGENTS_SKILLS, a.skill);
    const claudePath = join(CLAUDE_SKILLS, a.skill);
    switch (a.type) {
      case "remove-claude":
        rmIfExists(claudePath);
        done.push(`removed ~/.claude/skills/${a.skill}`);
        break;
      case "remove-agents": {
        if (a.verifyHash && lstatSync(agentsPath).isDirectory()) {
          const live = contentHash(agentsPath);
          if (live !== a.verifyHash && !opts.force) {
            skipped.push(`${a.skill}: live dir drifted from repo copy; run \`diff ${a.skill}\` then \`vendor ${a.skill}\` or use --force`);
            continue;
          }
        }
        rmIfExists(agentsPath);
        done.push(`removed ~/.agents/skills/${a.skill}`);
        break;
      }
      case "ensure-agents-symlink":
        rmIfExists(agentsPath);
        symlinkSync(a.target, agentsPath);
        done.push(`linked ~/.agents/skills/${a.skill} -> ${a.target}`);
        break;
      case "restore-agents-dir":
        rmIfExists(agentsPath);
        cpSync(a.from, agentsPath, { recursive: true });
        done.push(`restored ~/.agents/skills/${a.skill} from repo`);
        break;
      case "ensure-claude-symlink": {
        // Skip if canonical entry was skipped (avoid creating broken links).
        if (!existsSync(join(AGENTS_SKILLS, a.skill))) {
          skipped.push(`${a.skill}: skipped claude symlink (no canonical entry)`);
          continue;
        }
        rmIfExists(claudePath);
        symlinkSync(claudeRelTarget(a.skill), claudePath);
        done.push(`linked ~/.claude/skills/${a.skill}`);
        break;
      }
    }
  }
  return { done, skipped };
}
