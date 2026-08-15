import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, Context, Data, Effect, Layer, Option, Schema } from "effect";
import { ConfigFileError, errorDetail, isMissingFile, SlinkyConfig, version } from "../domain/model.ts";

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

/** Relative symlink target used inside ~/.claude/skills. */
export const claudeRelTarget = (name: string) => join("..", "..", ".agents", "skills", name);

/**
 * Outcome of skills-repo discovery. Resolution order:
 *   1. $SLINKY_REPO
 *   2. ~/.config/slinky/config.json { "version": 1, "host": "..." }
 *   3. walk up from this script's real location (development checkout)
 *   4. walk up from the current working directory
 */
export type RepoResolution = Data.TaggedEnum<{
  Found: { readonly repo: string };
  NotFound: {};
  Invalid: { readonly error: ConfigFileError };
}>;
export const RepoResolution = Data.taggedEnum<RepoResolution>();

function resolveRepo(slinkyConfig: string, envRepo: Option.Option<string>): RepoResolution {
  if (Option.isSome(envRepo)) {
    const repo = resolve(envRepo.value);
    return isRepoDir(repo)
      ? RepoResolution.Found({ repo })
      : RepoResolution.Invalid({
          error: new ConfigFileError("$SLINKY_REPO", "decode", `configured host has no skills.manifest.json: ${repo}`),
        });
  }

  let configRaw: string | undefined;
  try {
    configRaw = readFileSync(slinkyConfig, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) {
      return RepoResolution.Invalid({ error: new ConfigFileError(slinkyConfig, "read", errorDetail(error)) });
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
        return RepoResolution.Invalid({
          error: new ConfigFileError(slinkyConfig, "decode", `configured host has no skills.manifest.json: ${config.host}`),
        });
      }
      return RepoResolution.Found({ repo: config.host });
    } catch (error) {
      if (error instanceof ConfigFileError) return RepoResolution.Invalid({ error });
      return RepoResolution.Invalid({ error: new ConfigFileError(slinkyConfig, "decode", errorDetail(error)) });
    }
  }

  if (import.meta.url.startsWith("file:")) {
    const self = fileURLToPath(import.meta.url);
    if (!self.includes("$bunfs")) {
      // not a compiled binary: bun realpaths imports, so this is in the repo
      const found = walkUp(dirname(self));
      if (found) return RepoResolution.Found({ repo: found });
    }
  }
  const found = walkUp(process.cwd());
  return found === null ? RepoResolution.NotFound() : RepoResolution.Found({ repo: found });
}

export interface PathsInterface {
  readonly home: string;
  /** Config written by `slinky init` / `slinky bootstrap --clone`. */
  readonly slinkyConfig: string;
  /** Canonical global skill store (read natively by opencode; skills.sh installs here). */
  readonly agentsSkills: string;
  /** Claude Code reads this dir; entries should be relative symlinks into ~/.agents/skills. */
  readonly claudeSkills: string;
  /** opencode also reads this dir (in addition to ~/.agents/skills). */
  readonly opencodeSkills: string;
  /** skills.sh lock file (owned by `npx skills`; we only read it). */
  readonly skillLock: string;
  readonly resolution: RepoResolution;
  readonly saveHostConfig: (repo: string) => Effect.Effect<void, ConfigFileError>;
}

export class Paths extends Context.Service<Paths, PathsInterface>()("slinky/Paths") {
  static readonly layer: Layer.Layer<Paths> = Layer.effect(
    Paths,
    Effect.gen(function* () {
      const home = yield* Config.string("HOME").pipe(Config.withDefault(homedir()), Effect.orDie);
      const envRepo = yield* Config.option(Config.string("SLINKY_REPO")).pipe(Effect.map(Option.filter((value) => value !== "")), Effect.orDie);
      const slinkyConfig = join(home, ".config", "slinky", "config.json");

      const saveHostConfig = Effect.fn("Paths.saveHostConfig")(function* (repo: string) {
        yield* Effect.try({
          try: () => {
            const config = Schema.decodeUnknownSync(SlinkyConfig)({ version, host: resolve(repo) });
            const encoded = Schema.encodeSync(SlinkyConfig)(config, { onExcessProperty: "error" });
            const tmp = `${slinkyConfig}.${process.pid}.tmp`;
            mkdirSync(dirname(slinkyConfig), { recursive: true });
            writeFileSync(tmp, `${JSON.stringify(encoded, null, 2)}\n`);
            renameSync(tmp, slinkyConfig);
          },
          catch: (error) => (error instanceof ConfigFileError ? error : new ConfigFileError(slinkyConfig, "write", errorDetail(error))),
        });
      });

      return Paths.of({
        home,
        slinkyConfig,
        agentsSkills: join(home, ".agents", "skills"),
        claudeSkills: join(home, ".claude", "skills"),
        opencodeSkills: join(home, ".opencode", "skills"),
        skillLock: join(home, ".agents", ".skill-lock.json"),
        resolution: resolveRepo(slinkyConfig, envRepo),
        saveHostConfig,
      });
    }),
  );
}

export class RepoNotFoundError extends Schema.TaggedErrorClass<RepoNotFoundError>()("RepoNotFoundError", {
  message: Schema.String,
}) {
  constructor() {
    super({ message: "no skills repo found" });
  }
}

export interface HostRepoInterface {
  /** Repo root (the git clone that owns skills/, vendor/ and the manifest). */
  readonly repo: string;
  readonly manifestPath: string;
  readonly statePath: string;
  /**
   * Staging area. `npx skills add` run inside the repo installs here, because
   * skills.sh always writes `<scope-root>/.agents/skills/<name>` and offers no
   * way to target another directory. Slinky consolidates these into vendor/.
   */
  readonly stagedSkills: string;
  /** skills.sh project lock, written beside the staging area (owned by `npx skills`). */
  readonly stagedLock: string;
  /** Symlinks skills.sh points at the staging area; they dangle once we move a skill. */
  readonly stagedClaudeSkills: string;
}

/** Every repo-relative path Slinky cares about, derived from the repo root. */
export function hostRepoPaths(repo: string): HostRepoInterface {
  return {
    repo,
    manifestPath: join(repo, "skills.manifest.json"),
    statePath: join(repo, ".local", "state.json"),
    stagedSkills: join(repo, ".agents", "skills"),
    stagedLock: join(repo, "skills-lock.json"),
    stagedClaudeSkills: join(repo, ".claude", "skills"),
  };
}

export class HostRepo extends Context.Service<HostRepo, HostRepoInterface>()("slinky/HostRepo") {
  static readonly layer: Layer.Layer<HostRepo, RepoNotFoundError | ConfigFileError, Paths> = Layer.effect(
    HostRepo,
    Effect.gen(function* () {
      const paths = yield* Paths;
      const repo = yield* RepoResolution.$match(paths.resolution, {
        Found: ({ repo }) => Effect.succeed(repo),
        NotFound: () => Effect.fail(new RepoNotFoundError()),
        Invalid: ({ error }) => Effect.fail(error),
      });
      return HostRepo.of(hostRepoPaths(repo));
    }),
  );
}
