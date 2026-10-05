import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const EXCLUDE_MARKER = "# managed by my-agent-skills";

/** Pure: add lines (deduped) under the marker comment. */
export function addExcludeLines(existing: string, lines: string[]): string {
  const current = existing.split("\n");
  const present = new Set(current.map((l) => l.trim()));
  const toAdd = lines.filter((l) => !present.has(l.trim()));
  if (toAdd.length === 0) return existing;

  const out = [...current];
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (!present.has(EXCLUDE_MARKER)) out.push(EXCLUDE_MARKER);
  out.push(...toAdd, "");
  return out.join("\n");
}

/** Pure: remove exact lines; drop the marker if nothing managed remains under it. */
export function removeExcludeLines(existing: string, lines: string[]): string {
  const remove = new Set(lines.map((l) => l.trim()));
  const out = existing.split("\n").filter((l) => !remove.has(l.trim()));
  // Drop a trailing marker with no entries after it.
  const idx = out.indexOf(EXCLUDE_MARKER);
  if (idx !== -1 && out.slice(idx + 1).every((l) => l.trim() === "")) {
    out.splice(idx, 1);
  }
  return out.join("\n");
}

/** The git dir of a work tree: `.git` itself, or where a `.git` file points (linked worktrees, submodules). */
function gitDirFor(project: string): string | null {
  const dotGit = join(project, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    return pointer ? resolve(project, pointer) : null;
  } catch {
    return null;
  }
}

function commonDirFor(gitDir: string): string {
  try {
    return resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  } catch {
    return gitDir;
  }
}

/**
 * The `info/exclude` git reads for a work tree, or null outside git.
 *
 * A linked worktree has its own git dir, but git only reads `info/exclude` from the common dir, so
 * every worktree of a repository shares the main checkout's file.
 */
export function excludeFilePath(project: string): string | null {
  const gitDir = gitDirFor(project);
  if (!gitDir) return null;
  try {
    return join(realpathSync(commonDirFor(gitDir)), "info", "exclude");
  } catch {
    return null;
  }
}

export function updateExcludeFile(project: string, op: "add" | "remove", lines: string[]): string[] {
  const file = excludeFilePath(project);
  if (!file) return [];
  mkdirSync(dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const affected = lines.filter((line) => (op === "add" ? !present.has(line.trim()) : present.has(line.trim())));
  const next = op === "add" ? addExcludeLines(existing, lines) : removeExcludeLines(existing, lines);
  if (next !== existing) writeFileSync(file, next);
  return affected;
}
