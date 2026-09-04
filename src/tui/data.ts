import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { Effect } from "effect";
import { readdirIfExists } from "../lib/fs.ts";
import { contentHash, walkFiles } from "../lib/hash.ts";
import { classifyPlacement, inspectCatalogEntry, isDiscoverablePlacement } from "../domain/catalog-inspection.ts";
import type { CatalogLiveStatus, LiveEntry, Placement } from "../domain/catalog-inspection.ts";
import { diffDirs } from "../lib/diff.ts";
import { findUnindexedSkills } from "../lib/adopt.ts";
import type { UnindexedSkill } from "../lib/adopt.ts";
import type { DirDiff } from "../lib/diff.ts";
import type { EditorCommand } from "../lib/editor.ts";
import { isGlobalStoreProject } from "../lib/linker.ts";
import { isSkillEnabled } from "../domain/model.ts";
import type { Manifest, ProjectLink, Skill, State, ThemeId } from "../domain/model.ts";
import { ManifestStore } from "../lib/manifest.ts";
import { claudeRelTarget } from "../domain/reconcile-plan.ts";
import { HostRepo, Paths } from "../lib/paths.ts";
import { observe, observeEntry } from "../lib/reconcile.ts";
import type { UpstreamState } from "../lib/update.ts";

export type LiveStatus = CatalogLiveStatus;

/** Persist the TUI theme to ~/.config/slinky/config.json. */
export const saveTheme = (theme: ThemeId | null) => Effect.flatMap(Paths, (paths) => paths.saveTheme(theme));

export interface CatalogRow {
  name: string;
  origin: "local" | "vendor";
  enabled: boolean;
  liveEntry: LiveEntry;
  placement: Placement;
  live: LiveStatus;
  claude: boolean;
  projectLink: ProjectLink | null;
  projectSkill: ProjectSkill | null;
  meta: Skill;
  upstream?: UpstreamState;
}

export interface Catalog {
  manifest: Manifest;
  state: State;
  project: string;
  projectSkills: ProjectSkill[];
  unindexedSkills: UnindexedSkill[];
  rows: CatalogRow[];
  /** Host context snapshot so render helpers stay synchronous. */
  repo: string;
  agentsSkills: string;
  editorCommand: EditorCommand;
  /** Configured theme; undefined means the default. */
  theme: ThemeId | undefined;
}

export interface ProjectSkill {
  name: string;
  agents: boolean;
  claude: boolean;
}

export type ProjectPlacement = "none" | "link-hidden" | "link-tracked" | "copy-hidden" | "copy-tracked" | "missing" | "unmanaged";

export function projectPlacement(row: Pick<CatalogRow, "name" | "projectLink" | "projectSkill">): ProjectPlacement {
  if (!row.projectLink) return row.projectSkill ? "unmanaged" : "none";
  if (!row.projectSkill) return "missing";
  const hidden = row.projectLink.excludedTargets.includes(`.agents/skills/${row.name}`);
  if (row.projectLink.mode === "symlink") return hidden ? "link-hidden" : "link-tracked";
  return hidden ? "copy-hidden" : "copy-tracked";
}

/** Whether an agent can currently discover this skill globally or in the active project. */
export function isSkillAvailableHere(row: Pick<CatalogRow, "placement" | "projectSkill">): boolean {
  return isDiscoverablePlacement(row.placement) || row.projectSkill !== null;
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

/**
 * Skills present in a project's agent stores, treating `$HOME` as not a project.
 *
 * At `$HOME` the "project" stores are the global stores, so every installed skill would come back
 * as a project skill with no matching link and render as `unmanaged`.
 */
export function projectSkillsFor(project: string, agentsSkills: string): ProjectSkill[] {
  return isGlobalStoreProject(project, agentsSkills) ? [] : discoverProjectSkills(project);
}

/** Discover skills physically present in a project's agent stores. */
export function discoverProjectSkills(project: string): ProjectSkill[] {
  const found = new Map<string, ProjectSkill>();
  for (const [store, field] of [
    [join(project, ".agents", "skills"), "agents"],
    [join(project, ".claude", "skills"), "claude"],
  ] as const) {
    for (const entry of readdirIfExists(store)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skill = found.get(entry.name) ?? { name: entry.name, agents: false, claude: false };
      found.set(entry.name, { ...skill, [field]: true });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Fast load: no content hashing; vendor dirs report "checking" until verified. */
export const loadCatalog = Effect.fn("Tui.loadCatalog")(function* () {
  const store = yield* ManifestStore;
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);
  const obs = yield* observe();
  const project = projectForCwd(state);
  const projectSkills = projectSkillsFor(project, paths.agentsSkills);
  const unindexedSkills = findUnindexedSkills(manifest, repo);
  const projectSkillsByName = new Map(projectSkills.map((skill) => [skill.name, skill]));
  const rows: CatalogRow[] = Object.entries(manifest.skills).map(([name, meta]) => {
    const enabled = isSkillEnabled(manifest, state, name);
    const liveEntry: LiveEntry = Object.hasOwn(obs.agents, name) ? obs.agents[name]! : { kind: "missing" };
    const inspection = inspectCatalogEntry({
      origin: meta.origin,
      enabled,
      live: liveEntry,
      expectedTarget: resolve(repo, meta.path),
      vendorHash: { kind: "pending" },
    });
    const projectLink = state.projectLinks.find((link) => link.skill === name && resolve(link.project) === project) ?? null;
    return {
      name,
      origin: meta.origin,
      enabled,
      liveEntry: inspection.live,
      placement: inspection.placement,
      live: inspection.status,
      claude:
        classifyPlacement(Object.hasOwn(obs.claude, name) ? obs.claude[name]! : { kind: "missing" }, resolve(paths.claudeSkills, claudeRelTarget(name))) === "expected-symlink",
      projectLink,
      projectSkill: projectSkillsByName.get(name) ?? null,
      meta,
    };
  });
  return {
    manifest,
    state,
    project,
    projectSkills,
    unindexedSkills,
    rows,
    repo,
    agentsSkills: paths.agentsSkills,
    editorCommand: paths.editorCommand,
    theme: paths.theme,
  } satisfies Catalog;
});

/** Hash-verify one vendor row (the slow part, run incrementally). */
export function verifyRow(catalog: Pick<Catalog, "agentsSkills" | "repo">, row: CatalogRow): CatalogRow {
  if (row.live !== "checking") return row;
  const live = join(catalog.agentsSkills, row.name);
  const liveEntry = observeEntry(live);
  const inspection = inspectCatalogEntry({
    origin: row.origin,
    enabled: row.enabled,
    live: liveEntry,
    expectedTarget: resolve(catalog.repo, row.meta.path),
    vendorHash: { kind: "verified", matches: liveEntry.kind === "dir" && contentHash(live) === row.meta.contentHash },
  });
  return { ...row, liveEntry: inspection.live, placement: inspection.placement, live: inspection.status };
}

export type DiffResult = { kind: "local" } | { kind: "not-installed" } | { kind: "unowned" } | { kind: "diff"; diff: DirDiff };

export function diffSkill(catalog: Pick<Catalog, "repo" | "agentsSkills">, row: CatalogRow): DiffResult {
  if (row.origin === "local") return { kind: "local" };
  const live = join(catalog.agentsSkills, row.name);
  const placement = classifyPlacement(observeEntry(live), resolve(catalog.repo, row.meta.path));
  if (placement === "wrong-symlink" || placement === "file") return { kind: "unowned" };
  if (placement === "missing" || placement === "broken-symlink") return { kind: "not-installed" };
  return { kind: "diff", diff: diffDirs(join(catalog.repo, row.meta.path), live) };
}

export function linksForSkill(state: State, name: string): ReadonlyArray<ProjectLink> {
  return state.projectLinks.filter((l) => l.skill === name);
}

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function filesAt(root: string): string[] {
  try {
    return walkFiles(root).sort((a, b) => {
      if (a === "SKILL.md") return -1;
      if (b === "SKILL.md") return 1;
      return a < b ? -1 : 1;
    });
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
export function skillFiles(repo: string, meta: Skill): string[] {
  return filesAt(join(repo, meta.path));
}

export function readSkillFile(repo: string, meta: Skill, rel: string): string {
  return readFileContent(join(repo, meta.path), rel);
}

export function unindexedSkillFiles(skill: UnindexedSkill): string[] {
  return filesAt(skill.dir);
}

export function readUnindexedSkillFile(skill: UnindexedSkill, rel: string): string {
  return readFileContent(skill.dir, rel);
}

export function unindexedSkillDescription(skill: UnindexedSkill): string {
  return descriptionAt(skill.dir);
}

export function skillDescription(repo: string, meta: Skill): string {
  return descriptionAt(join(repo, meta.path));
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
