import { spawnSync } from "node:child_process";
import { join, posix, resolve } from "node:path";
import { Cache, Context, Duration, Effect, Exit, Layer, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { errorDetail, ExternalToolError, isSkillEnabled } from "../domain/model.ts";
import type { Manifest, State } from "../domain/model.ts";
import { inspectCatalogEntry } from "../domain/catalog-inspection.ts";
import type { LiveEntry } from "../domain/catalog-inspection.ts";
import { runGit } from "./git.ts";
import { contentHash } from "./hash.ts";
import { HostRepo, Paths } from "./paths.ts";
import { observe } from "./reconcile.ts";
import { seedGlobalSkillLock } from "./skill-lock.ts";

export type UpstreamState = "current" | "update" | "gone" | "unchecked";

export interface UpstreamStatus {
  name: string;
  state: UpstreamState;
  detail?: string;
}

interface CheckTarget {
  name: string;
  repo: string;
  parent: string;
  folder: string;
  localHash: string;
}

function checkTargets(manifest: Manifest): CheckTarget[] {
  const out: CheckTarget[] = [];
  for (const [name, meta] of Object.entries(manifest.skills)) {
    if (meta.origin !== "vendor") continue;
    if (meta.upstream.kind !== "github" || meta.upstream.tracking.kind !== "tree") continue;
    const folder = posix.dirname(meta.upstream.tracking.path);
    out.push({
      name,
      repo: meta.upstream.repository,
      parent: folder.includes("/") ? posix.dirname(folder) : "",
      folder: folder.split("/").pop() ?? folder,
      localHash: meta.upstream.tracking.hash,
    });
  }
  return out;
}

const GitHubContents = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    sha: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
  }),
);

export class GitHubError extends Schema.TaggedErrorClass<GitHubError>()("GitHubError", {
  message: Schema.String,
}) {}

export interface GitHubInterface {
  /** Git tree hashes of the entries in <repo>/<parent>, keyed by entry name. */
  readonly contentsShas: (repo: string, parent: string) => Effect.Effect<ReadonlyMap<string, string>, GitHubError>;
}

export class GitHub extends Context.Service<GitHub, GitHubInterface>()("slinky/GitHub") {
  static readonly layer: Layer.Layer<GitHub, never, HttpClient.HttpClient> = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("User-Agent", "slinky-skill-manager")),
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({
          times: 3,
          schedule: Schedule.exponential("300 millis").pipe(Schedule.jittered),
        }),
      );

      const lookup = (key: string) =>
        Effect.gen(function* () {
          const separator = key.indexOf("\0");
          if (separator < 0) return yield* Effect.fail(new GitHubError({ message: "invalid GitHub cache key" }));
          const repo = key.slice(0, separator);
          const parent = key.slice(separator + 1);
          const response = yield* client.get(`https://api.github.com/repos/${repo}/contents/${parent}`);
          const entries = yield* HttpClientResponse.schemaBodyJson(GitHubContents)(response);
          return new Map(entries.map((entry) => [entry.name, entry.sha]));
        }).pipe(Effect.mapError((error) => new GitHubError({ message: errorDetail(error) })));

      // Cache successes briefly (the TUI re-checks on every `u`); never cache failures.
      const cache = yield* Cache.makeWith(lookup, {
        capacity: 128,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(1) : Duration.zero),
      });

      return GitHub.of({
        contentsShas: Effect.fn("GitHub.contentsShas")(function* (repo: string, parent: string) {
          return yield* Cache.get(cache, `${repo}\0${parent}`);
        }),
      });
    }),
  );
}

/**
 * Compare persisted git tree hashes against GitHub without downloading
 * anything. Skills without tree provenance are reported as "unchecked".
 */
export const checkUpstream = Effect.fn("Update.checkUpstream")(function* (manifest: Manifest) {
  const github = yield* GitHub;
  const targets = checkTargets(manifest);
  const checked = new Map<string, UpstreamStatus>();

  const groups = new Map<string, CheckTarget[]>();
  for (const t of targets) {
    const key = `${t.repo}\0${t.parent}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(t);
    else groups.set(key, [t]);
  }

  yield* Effect.forEach(
    groups.values(),
    (members) =>
      Effect.gen(function* () {
        const { repo, parent } = members[0]!;
        const shas = yield* github.contentsShas(repo, parent);
        for (const t of members) {
          const remote = shas.get(t.folder);
          if (remote === undefined) checked.set(t.name, { name: t.name, state: "gone", detail: repo });
          else if (remote === t.localHash) checked.set(t.name, { name: t.name, state: "current" });
          else checked.set(t.name, { name: t.name, state: "update", detail: repo });
        }
      }).pipe(
        // An unreachable upstream leaves its skills "unchecked".
        Effect.catchTag("GitHubError", (error) =>
          Effect.sync(() => {
            for (const t of members) {
              checked.set(t.name, { name: t.name, state: "unchecked", detail: error.message });
            }
          }),
        ),
      ),
    { concurrency: 4, discard: true },
  );

  return Object.entries(manifest.skills)
    .filter(([, meta]) => meta.origin === "vendor")
    .map(([name]): UpstreamStatus => checked.get(name) ?? { name, state: "unchecked", detail: "no persisted upstream tree" });
});

/** Run skills.sh against the global store (writes live copies + lock file). */
export const runSkillsUpdate = Effect.fn("Update.runSkillsUpdate")(function* (manifest: Manifest, names: ReadonlyArray<string>) {
  yield* seedGlobalSkillLock(manifest, names);
  const res = yield* Effect.sync(() => spawnSync("npx", ["-y", "skills", "update", ...names, "-g", "-y"], { stdio: "inherit" }));
  const code = res.status ?? 1;
  if (code !== 0) {
    return yield* Effect.fail(new ExternalToolError({ tool: "npx skills", message: `skills.sh exited with ${code}` }));
  }
});

/**
 * Install into the repo's staging inbox (`<repo>/.agents/skills`) so Slinky can
 * consolidate from there. Project scope rather than `--global` for two reasons:
 * it keeps the install inside the repo we are about to vendor into, and it
 * avoids skills.sh trying to global-install into agents that do not support it.
 *
 * With no names, skills.sh runs its own interactive picker — deliberately, so
 * Slinky never has to reimplement skill discovery.
 */
export const runSkillsAdd = Effect.fn("Update.runSkillsAdd")(function* (source: string, names: ReadonlyArray<string>, cwd: string) {
  // `-a universal` targets only the canonical .agents/skills dir. Without it
  // skills.sh fans the install out across every agent it detects, littering the
  // repo with .claude symlinks and per-agent copies we would only have to undo.
  const args = ["-y", "skills", "add", source, "--project", "-a", "universal", ...names.flatMap((name) => ["--skill", name])];
  // `--yes` would silently select every skill, so only pass it once names are known.
  if (names.length > 0) args.push("--yes");
  const res = yield* Effect.sync(() => spawnSync("npx", args, { cwd, stdio: "inherit" }));
  const code = res.status ?? 1;
  if (code !== 0) {
    return yield* Effect.fail(new ExternalToolError({ tool: "npx skills", message: `skills.sh exited with ${code}` }));
  }
});

export interface UpdateOutcome {
  /** live copy differs from the repo baseline */
  changed: string[];
  /** enabled skill whose live copy disappeared (deleted upstream) */
  missing: string[];
  /** selected skill whose live path is not owned by this catalog */
  unowned: string[];
}

/** Compare live copies against the vendored baselines after an update. */
export const detectChanges = Effect.fn("Update.detectChanges")(function* (manifest: Manifest, state: State, names?: ReadonlyArray<string>) {
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;
  const observation = yield* observe();
  const changed: string[] = [];
  const missing: string[] = [];
  const unowned: string[] = [];
  for (const [name, meta] of Object.entries(manifest.skills)) {
    if (meta.origin !== "vendor") continue;
    if (names && names.length > 0 && !names.includes(name)) continue;
    const enabled = isSkillEnabled(manifest, state, name);
    const liveEntry: LiveEntry = Object.hasOwn(observation.agents, name) ? observation.agents[name]! : { kind: "missing" };
    const matches = liveEntry.kind === "dir" && contentHash(join(paths.agentsSkills, name)) === meta.contentHash;
    const inspection = inspectCatalogEntry({
      origin: meta.origin,
      enabled,
      live: liveEntry,
      expectedTarget: resolve(repo, meta.path),
      vendorHash: { kind: "verified", matches },
    });
    if (inspection.placement === "wrong-symlink" || inspection.placement === "file") {
      unowned.push(name);
    } else if (inspection.status === "missing") {
      missing.push(name);
    } else if (inspection.placement === "dir" ? !matches : inspection.placement !== "missing" && inspection.placement !== "broken-symlink") {
      changed.push(name);
    }
  }
  return { changed, missing, unowned } satisfies UpdateOutcome;
});

/** True when the baseline (vendor/, skills/, manifest, lock) has uncommitted changes. */
export const baselineDirty = Effect.fn("Update.baselineDirty")(function* () {
  const { repo } = yield* HostRepo;
  const status = yield* runGit(repo, ["status", "--porcelain", "--", "vendor", "skills", "skills.manifest.json", ".skill-lock.json"]);
  return status.stdout.trim().length > 0;
});
