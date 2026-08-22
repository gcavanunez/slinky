import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { formatUtc, getSkill, nowUtc, OperationFailed, ProjectLink, withoutProjectLink, withProjectLink } from "../domain/model.ts";
import type { Manifest, State } from "../domain/model.ts";
import { updateExcludeFile } from "./exclude.ts";
import { contentHash } from "./hash.ts";
import { tryOp } from "./ops.ts";
import { HostRepo, Paths } from "./paths.ts";

const decodeProjectLink = Schema.decodeUnknownSync(ProjectLink);

export interface LinkOptions {
  skill: string;
  project: string;
  mode: "copy" | "symlink";
  /** Also add entries to <project>/.git/info/exclude (default true). */
  gitExclude?: boolean;
  /** Create <project>/.claude/skills/<name> symlink when .claude exists (default true). */
  claude?: boolean;
}

export interface LinkResult {
  readonly state: State;
  readonly link: ProjectLink;
}

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const symlinkPointsTo = (path: string, target: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === resolve(target);
  } catch {
    return false;
  }
};

const excludeLine = (target: string): string => `/${target}`;
const excludeLinesForRemoval = (target: string): string[] => [excludeLine(target), `${excludeLine(target)}/`];

export function findLink(state: State, skill: string, project: string): ProjectLink | undefined {
  const resolved = resolve(project);
  return state.projectLinks.find((link) => link.skill === skill && resolve(link.project) === resolved);
}

function linkSkillSync(repo: string, manifest: Manifest, state: State, opts: LinkOptions): LinkResult {
  const meta = getSkill(manifest, opts.skill);
  if (!meta) throw new OperationFailed({ message: `unknown skill: ${opts.skill}` });
  const project = resolve(opts.project);
  if (!existsSync(project)) throw new OperationFailed({ message: `project dir not found: ${project}` });
  if (findLink(state, opts.skill, project)) {
    throw new OperationFailed({ message: `${opts.skill} is already linked into ${project} (unlink first)` });
  }

  const source = join(repo, meta.path);
  const destRel = posix.join(".agents", "skills", opts.skill);
  const dest = join(project, destRel);
  if (exists(dest)) throw new OperationFailed({ message: `destination already exists: ${dest}` });

  const targets: [string, ...string[]] = [destRel];
  let excludedTargets: string[] = [];
  try {
    mkdirSync(join(project, ".agents", "skills"), { recursive: true });
    if (opts.mode === "copy") {
      cpSync(source, dest, { recursive: true });
    } else {
      symlinkSync(source, dest);
    }

    const wantClaude = (opts.claude ?? true) && existsSync(join(project, ".claude"));
    if (wantClaude) {
      const claudeRel = posix.join(".claude", "skills", opts.skill);
      const claudeDest = join(project, claudeRel);
      if (!exists(claudeDest)) {
        mkdirSync(join(project, ".claude", "skills"), { recursive: true });
        symlinkSync(posix.join("..", "..", ".agents", "skills", opts.skill), claudeDest);
        targets.push(claudeRel);
      }
    }

    if (opts.gitExclude ?? true) {
      const lines = targets.map(excludeLine);
      const added = new Set(updateExcludeFile(project, "add", lines));
      excludedTargets = targets.filter((target) => added.has(excludeLine(target)));
    }

    const common = {
      project,
      skill: opts.skill,
      targets,
      excludedTargets,
      linkedAt: formatUtc(nowUtc()),
    };
    const linkInput = opts.mode === "copy" ? { ...common, mode: "copy", snapshotHash: contentHash(source) } : { ...common, mode: "symlink" };
    const link = decodeProjectLink(linkInput);

    return { state: withProjectLink(state, link), link };
  } catch (error) {
    if (excludedTargets.length > 0) {
      updateExcludeFile(project, "remove", excludedTargets.flatMap(excludeLinesForRemoval));
    }
    for (const target of [...targets].reverse()) {
      const path = join(project, target);
      if (exists(path)) rmSync(path, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Resolve symlinks as far as the path actually exists, keeping the missing tail.
 *
 * Comparing a store path that exists against one that does not would otherwise disagree wherever
 * an ancestor is a symlink, which on macOS is every temp dir and `/var`.
 */
function resolveDir(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Whether a directory's `.agents/skills` is the global store rather than a project's own.
 *
 * True for `$HOME`, where the "project" store and the global store are the same directory. Linking
 * there would copy a skill over its own global entry and record a project link against the store.
 */
export function isGlobalStoreProject(project: string, agentsSkills: string): boolean {
  return resolveDir(join(project, ".agents", "skills")) === resolveDir(agentsSkills);
}

/** Create a project link (copy or symlink) and return the updated state. Created paths are compensated on failure. */
export const linkSkill = Effect.fn("Linker.linkSkill")(function* (manifest: Manifest, state: State, opts: LinkOptions) {
  const { repo } = yield* HostRepo;
  const paths = yield* Paths;
  // Both guards sit here rather than in the CLI so the TUI, which links into whichever directory
  // it was opened in, cannot walk into them either.
  const project = resolveDir(opts.project);
  if (project === resolveDir(repo)) {
    return yield* Effect.fail(new OperationFailed({ message: "refusing to link a skill into the skills repo itself" }));
  }
  if (isGlobalStoreProject(project, paths.agentsSkills)) {
    return yield* Effect.fail(new OperationFailed({ message: `refusing to link a skill into ${project}: its .agents/skills is the global skill store` }));
  }
  return yield* tryOp(() => linkSkillSync(repo, manifest, state, opts));
});

function prepareUnlinkSync(repo: string, manifest: Manifest, state: State, skill: string, project: string, opts: { force?: boolean }): LinkResult {
  const link = findLink(state, skill, project);
  if (!link) throw new OperationFailed({ message: `no recorded link for ${skill} in ${project}` });
  const meta = getSkill(manifest, skill);
  if (!meta) throw new OperationFailed({ message: `unknown skill: ${skill}` });

  const canonicalRel = link.targets[0];
  const canonical = join(link.project, canonicalRel);
  if (!opts.force && exists(canonical)) {
    if (link.mode === "copy") {
      const stat = lstatSync(canonical);
      if (!stat.isDirectory() || contentHash(canonical) !== link.snapshotHash) {
        throw new OperationFailed({ message: `${skill} copy in ${project} was modified since linking; use --force to remove anyway` });
      }
    } else if (!symlinkPointsTo(canonical, join(repo, meta.path))) {
      throw new OperationFailed({ message: `${skill} symlink in ${project} was replaced or retargeted; use --force to remove anyway` });
    }
  }

  if (!opts.force) {
    for (const rel of link.targets.slice(1)) {
      const path = join(link.project, rel);
      if (exists(path) && !symlinkPointsTo(path, canonical)) {
        throw new OperationFailed({ message: `${skill} link target ${rel} was replaced or retargeted; use --force to remove anyway` });
      }
    }
  }

  return { state: withoutProjectLink(state, link), link };
}

/** Validate an unlink request and return the updated state without touching the filesystem. */
export const prepareUnlink = Effect.fn("Linker.prepareUnlink")(function* (manifest: Manifest, state: State, skill: string, project: string, opts: { force?: boolean } = {}) {
  const { repo } = yield* HostRepo;
  return yield* tryOp(() => prepareUnlinkSync(repo, manifest, state, skill, project, opts));
});

export function applyUnlink(link: ProjectLink): ReadonlyArray<string> {
  for (const rel of [...link.targets].reverse()) {
    const path = join(link.project, rel);
    if (exists(path)) rmSync(path, { recursive: true, force: true });
  }
  const warnings: string[] = [];
  if (link.excludedTargets.length > 0) {
    try {
      updateExcludeFile(link.project, "remove", link.excludedTargets.flatMap(excludeLinesForRemoval));
    } catch (error) {
      warnings.push(`could not clean .git/info/exclude in ${link.project}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return warnings;
}

export const unlinkSkill = Effect.fn("Linker.unlinkSkill")(function* (manifest: Manifest, state: State, skill: string, project: string, opts: { force?: boolean } = {}) {
  const prepared = yield* prepareUnlink(manifest, state, skill, project, opts);
  applyUnlink(prepared.link);
  return prepared;
});

export type LinkStatus = "ok" | "missing" | "drifted-local" | "outdated";

/** Health of a recorded link: missing paths, local edits (copy), or newer repo copy. */
export function checkLink(manifest: Manifest, link: ProjectLink, repo: string): LinkStatus {
  const meta = getSkill(manifest, link.skill);
  if (!meta) return "outdated";
  const canonicalRel = link.targets[0];
  const dest = join(link.project, canonicalRel);
  if (!exists(dest)) return "missing";
  if (link.mode === "symlink") {
    if (!symlinkPointsTo(dest, join(repo, meta.path))) return "drifted-local";
  } else {
    if (!lstatSync(dest).isDirectory()) return "drifted-local";
    const live = contentHash(dest);
    if (live !== link.snapshotHash) return "drifted-local";
    if (meta.contentHash !== link.snapshotHash) return "outdated";
  }
  for (const rel of link.targets.slice(1)) {
    const path = join(link.project, rel);
    if (!exists(path)) return "missing";
    if (!symlinkPointsTo(path, dest)) return "drifted-local";
  }
  return "ok";
}
