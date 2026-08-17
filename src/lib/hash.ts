import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Junk that git typically ignores; excluded so repo clones hash identically. */
const IGNORED_DIRS = new Set(["__pycache__", ".git", "node_modules"]);
const IGNORED_FILES = new Set([".DS_Store"]);
const IGNORED_EXTENSIONS = [".pyc"];

/**
 * Collect relative POSIX paths of regular files under root.
 * Does not follow symlinks (neither file nor directory symlinks).
 */
export function walkFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const st = lstatSync(join(root, rel));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) out.push(...walkFiles(root, rel));
    } else if (st.isFile()) {
      if (IGNORED_FILES.has(entry) || IGNORED_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
      out.push(rel);
    }
  }
  return out;
}

/** Symlinks are not content-hashed, so callers can reject them when persisting a verified baseline. */
export function findSymlinks(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const st = lstatSync(join(root, rel));
    if (st.isSymbolicLink()) out.push(rel);
    else if (st.isDirectory() && !IGNORED_DIRS.has(entry)) out.push(...findSymlinks(root, rel));
  }
  return out;
}

/**
 * Stable sha256 over sorted relative paths + file contents.
 * Matches the Phase 1 migration hasher: for each file (sorted by full path
 * string), update(relpath) 0x00 update(bytes) 0x00.
 */
export function contentHash(root: string): string {
  const files = walkFiles(root).sort();
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(root, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}
