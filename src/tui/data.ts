import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { contentHash, walkFiles } from "../lib/hash.ts";
import { diffDirs } from "../lib/diff.ts";
import type { DirDiff } from "../lib/diff.ts";
import { isSkillEnabled, loadManifest, loadState } from "../lib/manifest.ts";
import type { Manifest, ProjectLink, Skill, State } from "../lib/manifest.ts";
import { AGENTS_SKILLS, REPO } from "../lib/paths.ts";
import { observe } from "../lib/reconcile.ts";
import type { LiveKind } from "../lib/reconcile.ts";

export type LiveStatus = "ok" | "drift" | "missing" | "off" | "stale" | "checking";
export type { UpstreamState } from "../lib/update.ts";

export interface CatalogRow {
  name: string;
  origin: "local" | "vendor";
  enabled: boolean;
  liveKind: LiveKind;
  live: LiveStatus;
  claude: boolean;
  projectLink: ProjectLink | null;
  projectSkill: ProjectSkill | null;
  meta: Skill;
  upstream?: import("../lib/update.ts").UpstreamState;
}

export interface Catalog {
  manifest: Manifest;
  state: State;
  project: string;
  projectSkills: ProjectSkill[];
  rows: CatalogRow[];
}

export interface ProjectSkill {
  name: string;
  agents: boolean;
  claude: boolean;
}

/** Resolve cwd to the nearest recorded project, falling back to cwd itself. */
export function projectForCwd(state: State, cwd: string = process.cwd()): string {
  const current = resolve(cwd);
  const projects = new Set(state.projectLinks.map((link) => resolve(link.project)));
  return (
    [...projects]
      .filter((project) => {
        const child = relative(project, current);
        return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
      })
      .sort((a, b) => b.length - a.length)[0] ?? current
  );
}

/** Discover skills physically present in a project's agent stores. */
export function discoverProjectSkills(project: string): ProjectSkill[] {
  const found = new Map<string, ProjectSkill>();
  for (const [store, field] of [
    [join(project, ".agents", "skills"), "agents"],
    [join(project, ".claude", "skills"), "claude"],
  ] as const) {
    try {
      for (const entry of readdirSync(store, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skill = found.get(entry.name) ?? { name: entry.name, agents: false, claude: false };
        found.set(entry.name, { ...skill, [field]: true });
      }
    } catch {}
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Fast load: no content hashing; vendor dirs report "checking" until verified. */
export function loadCatalog(): Catalog {
  const manifest = loadManifest();
  const state = loadState(manifest);
  const obs = observe();
  const project = projectForCwd(state);
  const projectSkills = discoverProjectSkills(project);
  const projectSkillsByName = new Map(projectSkills.map((skill) => [skill.name, skill]));
  const rows: CatalogRow[] = Object.entries(manifest.skills).map(([name, meta]) => {
    const enabled = isSkillEnabled(state, name);
    const liveKind: LiveKind = Object.hasOwn(obs.agents, name) ? obs.agents[name]!.kind : "missing";
    let live: LiveStatus;
    if (!enabled) {
      live = liveKind === "missing" ? "off" : "stale";
    } else if (meta.origin === "local") {
      live = liveKind === "symlink" ? "ok" : "missing";
    } else {
      live = liveKind === "dir" ? "checking" : "missing";
    }
    const projectLink = state.projectLinks.find((link) => link.skill === name && resolve(link.project) === project) ?? null;
    return {
      name,
      origin: meta.origin,
      enabled,
      liveKind,
      live,
      claude: Object.hasOwn(obs.claude, name),
      projectLink,
      projectSkill: projectSkillsByName.get(name) ?? null,
      meta,
    };
  });
  return { manifest, state, project, projectSkills, rows };
}

/** Hash-verify one vendor row (the slow part, run incrementally). */
export function verifyRow(row: CatalogRow): CatalogRow {
  if (row.live !== "checking") return row;
  const live = join(AGENTS_SKILLS, row.name);
  const ok = existsSync(live) && contentHash(live) === row.meta.contentHash;
  return { ...row, live: ok ? "ok" : "drift" };
}

export type DiffResult = { kind: "local" } | { kind: "not-installed" } | { kind: "diff"; diff: DirDiff };

export function diffSkill(row: CatalogRow): DiffResult {
  if (row.origin === "local") return { kind: "local" };
  const live = join(AGENTS_SKILLS, row.name);
  if (!existsSync(live)) return { kind: "not-installed" };
  return { kind: "diff", diff: diffDirs(join(REPO, row.meta.path), live) };
}

export function linksForSkill(state: State, name: string): ReadonlyArray<ProjectLink> {
  return state.projectLinks.filter((l) => l.skill === name);
}

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function filesAt(root: string): string[] {
  try {
    return walkFiles(root).sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a < b ? -1 : 1));
  } catch {
    return [];
  }
}

function readFileContent(root: string, rel: string): string {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return "(unreadable file)";
  }
}

function descriptionAt(root: string): string {
  try {
    const raw = readFileSync(join(root, "SKILL.md"), "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m?.[1]) return "";
    const fm = m[1];
    const dm = fm.match(/^description:\s*(.*)$/m);
    if (!dm?.[1]) return "";
    let value = dm[1].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      // block scalar: take the first indented line
      const after = fm.slice(fm.indexOf(dm[0]) + dm[0].length);
      value =
        after
          .split("\n")
          .find((l) => l.trim().length > 0)
          ?.trim() ?? "";
    }
    return value.replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}

/** Files inside a skill's host folder, SKILL.md first. */
export function skillFiles(meta: Skill): string[] {
  return filesAt(join(REPO, meta.path));
}

export function readSkillFile(meta: Skill, rel: string): string {
  return readFileContent(join(REPO, meta.path), rel);
}

export function skillDescription(meta: Skill): string {
  return descriptionAt(join(REPO, meta.path));
}

export function projectSkillPath(project: string, skill: ProjectSkill): string {
  return join(project, skill.agents ? ".agents" : ".claude", "skills", skill.name);
}

export function projectSkillFiles(project: string, skill: ProjectSkill): string[] {
  return filesAt(projectSkillPath(project, skill));
}

export function readProjectSkillFile(project: string, skill: ProjectSkill, rel: string): string {
  return readFileContent(projectSkillPath(project, skill), rel);
}

export function projectSkillDescription(project: string, skill: ProjectSkill): string {
  return descriptionAt(projectSkillPath(project, skill));
}
