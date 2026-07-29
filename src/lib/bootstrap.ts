import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { AGENTS_SKILLS, CLAUDE_SKILLS, HOME, OPENCODE_SKILLS } from "./paths.ts";

export const BACKUP_DIR = join(HOME, ".local", "state", "my-agent-skills-backups");

/**
 * Tar up the global skill dirs (symlinks preserved as symlinks) before we
 * touch anything. Returns the archive path, or null when nothing exists yet.
 */
export function backupGlobalDirs(): string | null {
  const targets = [AGENTS_SKILLS, CLAUDE_SKILLS, OPENCODE_SKILLS].filter((d) => existsSync(d)).map((d) => relative(HOME, d));
  if (targets.length === 0) return null;

  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archive = join(BACKUP_DIR, `skills-backup-${stamp}.tar.gz`);
  const res = spawnSync("tar", ["czf", archive, "-C", HOME, ...targets], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`backup failed: ${res.stderr || res.error?.message || "tar exited non-zero"}`);
  }
  return archive;
}
