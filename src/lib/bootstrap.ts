import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { ExternalToolError } from "../domain/model.ts";
import { Paths } from "./paths.ts";

export const backupDirFor = (home: string) => join(home, ".local", "state", "my-agent-skills-backups");

/**
 * Tar up the global skill dirs (symlinks preserved as symlinks) before we
 * touch anything. Returns the archive path, or null when nothing exists yet.
 */
export const backupGlobalDirs = Effect.fn("Bootstrap.backupGlobalDirs")(function* () {
  const paths = yield* Paths;
  const targets = [paths.agentsSkills, paths.claudeSkills, paths.opencodeSkills].filter((d) => existsSync(d)).map((d) => relative(paths.home, d));
  if (targets.length === 0) return null;

  const backupDir = backupDirFor(paths.home);
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archive = join(backupDir, `skills-backup-${stamp}.tar.gz`);
  const res = yield* Effect.sync(() => spawnSync("tar", ["czf", archive, "-C", paths.home, ...targets], { encoding: "utf8" }));
  if (res.status !== 0) {
    return yield* Effect.fail(new ExternalToolError({ tool: "tar", message: `backup failed: ${res.stderr || res.error?.message || "tar exited non-zero"}` }));
  }
  return archive;
});
