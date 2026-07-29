import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import * as Schema from "effect/Schema";
import { isSkillEnabled } from "../domain/model.ts";
import { contentHash } from "./hash.ts";
import type { Manifest, State } from "./manifest.ts";
import { AGENTS_SKILLS, REPO } from "./paths.ts";

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

/**
 * Compare persisted git tree hashes against GitHub without downloading
 * anything. Skills without tree provenance are reported as "unchecked".
 */
export async function checkUpstream(manifest: Manifest): Promise<UpstreamStatus[]> {
  const targets = checkTargets(manifest);
  const checked = new Map<string, UpstreamStatus>();

  const groups = new Map<string, CheckTarget[]>();
  for (const t of targets) {
    const key = `${t.repo}\0${t.parent}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(t);
    else groups.set(key, [t]);
  }

  await Promise.all(
    [...groups.entries()].map(async ([key, members]) => {
      const [repo, parent] = key.split("\0") as [string, string];
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/contents/${parent}`, {
          headers: { "User-Agent": "slinky-skill-manager" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const entries = Schema.decodeUnknownSync(GitHubContents)(await res.json());
        const shas = new Map(entries.map((e) => [e.name, e.sha]));
        for (const t of members) {
          const remote = shas.get(t.folder);
          if (remote === undefined) checked.set(t.name, { name: t.name, state: "gone", detail: repo });
          else if (remote === t.localHash) checked.set(t.name, { name: t.name, state: "current" });
          else checked.set(t.name, { name: t.name, state: "update", detail: repo });
        }
      } catch (err) {
        for (const t of members) {
          checked.set(t.name, {
            name: t.name,
            state: "unchecked",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }),
  );

  return Object.entries(manifest.skills)
    .filter(([, meta]) => meta.origin === "vendor")
    .map(([name]) => checked.get(name) ?? { name, state: "unchecked", detail: "no persisted upstream tree" });
}

/** Run skills.sh against the global store (writes live copies + lock file). */
export function runSkillsUpdate(names: string[]): number {
  const res = spawnSync("npx", ["-y", "skills", "update", ...names, "-g", "-y"], {
    stdio: "inherit",
  });
  return res.status ?? 1;
}

export interface UpdateOutcome {
  /** live copy differs from the repo baseline */
  changed: string[];
  /** enabled skill whose live copy disappeared (deleted upstream) */
  missing: string[];
}

/** Compare live copies against the vendored baselines after an update. */
export function detectChanges(manifest: Manifest, state: State, names?: string[]): UpdateOutcome {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [name, meta] of Object.entries(manifest.skills)) {
    if (meta.origin !== "vendor") continue;
    if (names && names.length > 0 && !names.includes(name)) continue;
    const live = join(AGENTS_SKILLS, name);
    if (!existsSync(live)) {
      if (isSkillEnabled(state, name)) missing.push(name);
    } else if (contentHash(live) !== meta.contentHash) {
      changed.push(name);
    }
  }
  return { changed, missing };
}

/** True when the baseline (vendor/, skills/, manifest) has uncommitted changes. */
export function baselineDirty(): boolean {
  const res = spawnSync("git", ["status", "--porcelain", "--", "vendor", "skills", "skills.manifest.json"], { cwd: REPO, encoding: "utf8" });
  if (res.error) throw new Error(`git status failed: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`git status failed (${res.status ?? "unknown"}): ${(res.stderr ?? "").trim()}`);
  }
  return (res.stdout ?? "").trim().length > 0;
}
