import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { Effect } from "effect";
import { ExternalToolError } from "../domain/model.ts";
import { Paths } from "./paths.ts";

export const backupDirFor = (home: string) => join(home, ".local", "state", "my-agent-skills-backups");

/**
 * Tar up the global skill dirs and skills.sh lock (symlinks preserved) before we
 * touch anything. Returns the archive path, or null when nothing exists yet.
 */
export const backupGlobalDirs = Effect.fn("Bootstrap.backupGlobalDirs")(function* () {
  const paths = yield* Paths;
  const targets = [paths.agentsSkills, paths.claudeSkills, paths.opencodeSkills].filter((path) => existsSync(path)).map((path) => relative(paths.home, path));
  const lockRelative = relative(paths.home, paths.skillLock);
  const lockInHome = lockRelative !== ".." && !lockRelative.startsWith(`..${sep}`);
  if (existsSync(paths.skillLock) && lockInHome) targets.push(lockRelative);
  const externalLock = existsSync(paths.skillLock) && !lockInHome;
  if (targets.length === 0 && !externalLock) return null;

  const backupDir = backupDirFor(paths.home);
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archive = join(backupDir, `skills-backup-${stamp}.tar.gz`);
  const args = ["czf", archive];
  if (targets.length > 0) args.push("-C", paths.home, ...targets);
  if (externalLock) args.push("-C", dirname(paths.skillLock), basename(paths.skillLock));
  const res = yield* Effect.sync(() => spawnSync("tar", args, { encoding: "utf8" }));
  if (res.status !== 0) {
    return yield* Effect.fail(new ExternalToolError({ tool: "tar", message: `backup failed: ${res.stderr || res.error?.message || "tar exited non-zero"}` }));
  }
  return archive;
});
