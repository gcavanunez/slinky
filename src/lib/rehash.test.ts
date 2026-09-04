import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { contentHash } from "./hash.ts";
import { Manifest, version } from "../domain/model.ts";
import { refreshLocalHashes } from "./rehash.ts";

const STALE = "0".repeat(64);

function repoWith(skills: ReadonlyArray<string>): string {
  const repo = mkdtempSync(join(tmpdir(), "slinky-rehash-"));
  for (const path of skills) {
    mkdirSync(join(repo, path), { recursive: true });
    writeFileSync(join(repo, path, "SKILL.md"), `# ${path}\n`);
  }
  return repo;
}

function manifest(repo: string): Manifest {
  return Schema.decodeUnknownSync(Manifest)({
    version,
    skills: {
      edited: { origin: "local", path: "skills/edited", contentHash: STALE },
      current: { origin: "local", path: "skills/current", contentHash: contentHash(join(repo, "skills/current")) },
      vendored: {
        origin: "vendor",
        path: "vendor/acme/vendored",
        contentHash: STALE,
        upstream: { kind: "unknown", note: null },
        vendoredAt: null,
      },
    },
    profiles: {},
  });
}

describe("refreshLocalHashes", () => {
  test("refreshes every stale local skill when no names are given", () => {
    const repo = repoWith(["skills/edited", "skills/current", "vendor/acme/vendored"]);
    const result = refreshLocalHashes(manifest(repo), repo);

    expect(result.refreshed).toEqual(["edited"]);
    expect(result.manifest.skills.edited?.contentHash).toBe(contentHash(join(repo, "skills/edited")));
    rmSync(repo, { recursive: true, force: true });
  });

  test("leaves a stale vendor baseline alone so verification still catches it", () => {
    const repo = repoWith(["skills/edited", "skills/current", "vendor/acme/vendored"]);
    const result = refreshLocalHashes(manifest(repo), repo);

    expect(result.refreshed).not.toContain("vendored");
    expect(result.manifest.skills.vendored?.contentHash).toBe(STALE);
    rmSync(repo, { recursive: true, force: true });
  });

  test("returns the manifest untouched when nothing drifted", () => {
    const repo = repoWith(["skills/edited", "skills/current", "vendor/acme/vendored"]);
    const refreshedOnce = refreshLocalHashes(manifest(repo), repo).manifest;

    const result = refreshLocalHashes(refreshedOnce, repo);

    expect(result.refreshed).toEqual([]);
    expect(result.manifest).toBe(refreshedOnce);
    rmSync(repo, { recursive: true, force: true });
  });

  test("skips a local skill whose repo copy is missing", () => {
    const repo = repoWith(["skills/current", "vendor/acme/vendored"]);
    const result = refreshLocalHashes(manifest(repo), repo);

    expect(result.refreshed).toEqual([]);
    expect(result.manifest.skills.edited?.contentHash).toBe(STALE);
    rmSync(repo, { recursive: true, force: true });
  });

  test("restricts itself to the named skills", () => {
    const repo = repoWith(["skills/edited", "skills/current", "vendor/acme/vendored"]);
    const result = refreshLocalHashes(manifest(repo), repo, ["current"]);

    expect(result.refreshed).toEqual([]);
    expect(result.manifest.skills.edited?.contentHash).toBe(STALE);
    rmSync(repo, { recursive: true, force: true });
  });
});
