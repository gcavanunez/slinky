import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { ConfigFileError, SlinkyConfig, version } from "../domain/model.ts";

export const HOME = homedir();

/** Config written by `slinky init` / `slinky bootstrap --clone`. */
export const SLINKY_CONFIG = join(HOME, ".config", "slinky", "config.json");

/** A directory qualifies as the skills repo when the manifest is present. */
export function isRepoDir(dir: string): boolean {
  return existsSync(join(dir, "skills.manifest.json"));
}

function walkUp(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (isRepoDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Locate the skills repo (the git clone that owns skills/, vendor/ and the
 * manifest). Resolution order:
 *   1. $SLINKY_REPO
 *   2. ~/.config/slinky/config.json { "version": 1, "host": "..." }
 *   3. walk up from this script's real location (development checkout)
 *   4. walk up from the current working directory
 */
interface RepoResolution {
  readonly repo: string | null;
  readonly error?: ConfigFileError;
}

const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

function resolveRepo(): RepoResolution {
  const env = process.env["SLINKY_REPO"];
  if (env) {
    const repo = resolve(env);
    return isRepoDir(repo)
      ? { repo }
      : {
          repo: null,
          error: new ConfigFileError("$SLINKY_REPO", "decode", `configured host has no skills.manifest.json: ${repo}`),
        };
  }

  let configRaw: string | undefined;
  try {
    configRaw = readFileSync(SLINKY_CONFIG, "utf8");
  } catch (error) {
    if (!isMissing(error)) {
      return { repo: null, error: new ConfigFileError(SLINKY_CONFIG, "read", detail(error)) };
    }
  }
  if (configRaw !== undefined) {
    try {
      const input = JSON.parse(configRaw);
      const config = Schema.decodeUnknownSync(SlinkyConfig)(input, {
        errors: "all",
        onExcessProperty: "error",
      });
      if (!isRepoDir(config.host)) {
        return {
          repo: null,
          error: new ConfigFileError(SLINKY_CONFIG, "decode", `configured host has no skills.manifest.json: ${config.host}`),
        };
      }
      return { repo: config.host };
    } catch (error) {
      if (error instanceof ConfigFileError) return { repo: null, error };
      return { repo: null, error: new ConfigFileError(SLINKY_CONFIG, "decode", detail(error)) };
    }
  }

  try {
    const self = fileURLToPath(import.meta.url);
    if (!self.includes("$bunfs")) {
      // not a compiled binary: bun realpaths imports, so this is in the repo
      const found = walkUp(dirname(self));
      if (found) return { repo: found };
    }
  } catch {}
  return { repo: walkUp(process.cwd()) };
}

const resolution = resolveRepo();

/** Repo root; empty string when undiscovered (commands guard via repoFound). */
export const REPO = resolution.repo ?? "";
export const repoFound = REPO !== "";
export const repoResolutionError = resolution.error;

/** Canonical global skill store (read natively by opencode; skills.sh installs here). */
export const AGENTS_SKILLS = join(HOME, ".agents", "skills");

/** Claude Code reads this dir; entries should be relative symlinks into ~/.agents/skills. */
export const CLAUDE_SKILLS = join(HOME, ".claude", "skills");

/** opencode also reads this dir (in addition to ~/.agents/skills). */
export const OPENCODE_SKILLS = join(HOME, ".opencode", "skills");

/** skills.sh lock file (owned by `npx skills`; we only read it). */
export const SKILL_LOCK = join(HOME, ".agents", ".skill-lock.json");

export const MANIFEST_PATH = join(REPO, "skills.manifest.json");
export const STATE_PATH = join(REPO, ".local", "state.json");

export function saveHostConfig(repo: string): void {
  const config = Schema.decodeUnknownSync(SlinkyConfig)({ version, host: resolve(repo) });
  const encoded = Schema.encodeSync(SlinkyConfig)(config, { onExcessProperty: "error" });
  const tmp = `${SLINKY_CONFIG}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(SLINKY_CONFIG), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(encoded, null, 2)}\n`);
    renameSync(tmp, SLINKY_CONFIG);
  } catch (error) {
    throw new ConfigFileError(SLINKY_CONFIG, "write", detail(error));
  }
}

/** Relative symlink target used inside ~/.claude/skills. */
export const claudeRelTarget = (name: string) => join("..", "..", ".agents", "skills", name);
