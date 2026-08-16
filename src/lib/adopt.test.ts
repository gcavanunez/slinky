import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { adoptDestination, backfillTreeHash, clearStagingResidue, decodeSkillLock, findStaged, findUnindexedSkills, upstreamFromLock } from "./adopt.ts";
import type { ForeignSkill, LockMeta } from "./adopt.ts";
import type { Manifest } from "./manifest.ts";
import { contentHash } from "./hash.ts";
import { HostRepo, hostRepoPaths } from "./paths.ts";
import { GitHub, GitHubError } from "./update.ts";

const base: ForeignSkill = { name: "foo", location: "agents", dir: "/x/foo" };

describe("adoptDestination", () => {
  test("local flag wins", () => {
    expect(adoptDestination(base, { local: true })).toBe("skills/foo");
  });

  test("github lock provenance maps to owner dir", () => {
    const cand: ForeignSkill = {
      ...base,
      lock: { source: "acme/skills", sourceType: "github" },
    };
    expect(adoptDestination(cand, {})).toBe("vendor/acme/foo");
  });

  test("well-known lock provenance uses the source verbatim", () => {
    const cand: ForeignSkill = {
      ...base,
      lock: { source: "docs.stripe.com", sourceType: "well-known" },
    };
    expect(adoptDestination(cand, {})).toBe("vendor/docs.stripe.com/foo");
  });

  test("explicit owner overrides lock provenance", () => {
    const cand: ForeignSkill = {
      ...base,
      lock: { source: "acme/skills", sourceType: "github" },
    };
    expect(adoptDestination(cand, { owner: "someone" })).toBe("vendor/someone/foo");
  });

  test("unknown provenance falls back to _unknown", () => {
    expect(adoptDestination(base, {})).toBe("vendor/_unknown/foo");
  });

  test("rejects owners that do not produce vendor/<owner>/<name>", () => {
    expect(() => adoptDestination(base, { owner: ".." })).toThrow();
    expect(() => adoptDestination(base, { owner: "team/nested" })).toThrow();
  });
});

describe("upstreamFromLock", () => {
  test("accepts skills.sh well-known entries with empty folder hashes", () => {
    const lockFile = {
      version: 3,
      skills: {
        stripe: {
          source: "docs.stripe.com",
          sourceType: "well-known",
          sourceUrl: "https://docs.stripe.com/.well-known/skills/stripe/SKILL.md",
          skillFolderHash: "",
          installedAt: "2026-04-06T18:03:28.142Z",
        },
      },
    } as const;
    const skills = decodeSkillLock(lockFile);

    expect(skills.stripe?.sourceType).toBe("well-known");
  });

  test("normalizes tracked GitHub provenance", () => {
    const upstream = upstreamFromLock({
      source: "acme/skills",
      sourceType: "github",
      sourceUrl: "https://github.com/acme/skills",
      skillPath: "skills/foo/SKILL.md",
      skillFolderHash: "a".repeat(40),
    });

    expect(upstream.kind).toBe("github");
    if (upstream.kind !== "github") throw new Error("expected GitHub upstream");
    expect(upstream.repository).toBe("acme/skills");
    expect(upstream.tracking.kind).toBe("tree");
  });

  test("represents missing provenance explicitly", () => {
    expect(upstreamFromLock(undefined).kind).toBe("unknown");
  });
});

const hashOf = (repo: string, rel: string): string => contentHash(join(repo, rel));

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repo with `<repo>/.agents/skills/<name>` staged and a project lock. */
type ProjectLockMeta = LockMeta & { readonly computedHash?: string };
interface StagedRepoEntry {
  readonly body: string;
  readonly lock?: ProjectLockMeta;
}

function stagedRepo(entries: Readonly<Record<string, StagedRepoEntry>>): string {
  const repo = mkdtempSync(join(tmpdir(), "slinky-staged-"));
  roots.push(repo);
  const lock: Record<string, ProjectLockMeta> = {};
  for (const [name, { body, lock: meta }] of Object.entries(entries)) {
    mkdirSync(join(repo, ".agents", "skills", name), { recursive: true });
    writeFileSync(join(repo, ".agents", "skills", name, "SKILL.md"), body);
    if (meta) lock[name] = meta;
  }
  if (Object.keys(lock).length > 0) writeFileSync(join(repo, "skills-lock.json"), `${JSON.stringify({ version: 1, skills: lock }, null, 2)}\n`);
  return repo;
}

const runInRepo = <A, E>(repo: string, effect: Effect.Effect<A, E, HostRepo>): A =>
  Effect.runSync(effect.pipe(Effect.provide(Layer.succeed(HostRepo, HostRepo.of(hostRepoPaths(repo))))));

const emptyManifest: Manifest = { version: 1, skills: {}, profiles: {} };

describe("findStaged", () => {
  test("classifies staged skills against the manifest", () => {
    const repo = stagedRepo({
      fresh: { body: "# fresh\n", lock: { source: "acme/pack", sourceType: "github", skillPath: "skills/fresh/SKILL.md", computedHash: "x" } },
      same: { body: "# same\n" },
      moved: { body: "# moved v2\n" },
    });
    mkdirSync(join(repo, "vendor", "acme", "same"), { recursive: true });
    writeFileSync(join(repo, "vendor", "acme", "same", "SKILL.md"), "# same\n");
    mkdirSync(join(repo, "vendor", "acme", "moved"), { recursive: true });
    writeFileSync(join(repo, "vendor", "acme", "moved", "SKILL.md"), "# moved v1\n");

    const manifest: Manifest = {
      version: 1,
      skills: {
        same: { origin: "vendor", path: "vendor/acme/same", contentHash: hashOf(repo, "vendor/acme/same"), upstream: { kind: "unknown", note: "n" }, vendoredAt: null },
        moved: { origin: "vendor", path: "vendor/acme/moved", contentHash: hashOf(repo, "vendor/acme/moved"), upstream: { kind: "unknown", note: "n" }, vendoredAt: null },
      },
      profiles: {},
    };

    const scan = runInRepo(repo, findStaged(manifest));
    expect(scan.staged.map((entry) => [entry.candidate.name, entry.status.kind])).toEqual([
      ["fresh", "new"],
      ["moved", "changed"],
      ["same", "duplicate"],
    ]);
    // Provenance is carried through from the project lock.
    expect(scan.staged.find((entry) => entry.candidate.name === "fresh")?.candidate.lock?.source).toBe("acme/pack");
  });

  test("ignores symlinks, which are managed project links rather than fresh installs", () => {
    const repo = stagedRepo({ real: { body: "# real\n" } });
    mkdirSync(join(repo, "skills", "linked"), { recursive: true });
    writeFileSync(join(repo, "skills", "linked", "SKILL.md"), "# linked\n");
    symlinkSync(join(repo, "skills", "linked"), join(repo, ".agents", "skills", "linked"));

    expect(runInRepo(repo, findStaged(emptyManifest)).staged.map((entry) => entry.candidate.name)).toEqual(["real"]);
  });
});

describe("clearStagingResidue", () => {
  test("removes the dangling claude symlink and prunes the lock entry", () => {
    const repo = stagedRepo({
      gone: { body: "# gone\n", lock: { source: "acme/pack", sourceType: "github" } },
      kept: { body: "# kept\n", lock: { source: "acme/pack", sourceType: "github" } },
    });
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    symlinkSync(join("..", "..", ".agents", "skills", "gone"), join(repo, ".claude", "skills", "gone"));
    // Adoption has already moved the staged dir out, so the symlink now dangles.
    rmSync(join(repo, ".agents", "skills", "gone"), { recursive: true });

    expect(runInRepo(repo, clearStagingResidue("gone"))).toEqual([]);
    expect(existsSync(join(repo, ".claude", "skills", "gone"))).toBe(false);
    const lock = decodeSkillLock(JSON.parse(readFileSync(join(repo, "skills-lock.json"), "utf8")));
    expect(Object.keys(lock)).toEqual(["kept"]);
  });

  test("removes the lock file once its last entry is pruned", () => {
    const repo = stagedRepo({ only: { body: "# only\n", lock: { source: "acme/pack", sourceType: "github" } } });
    runInRepo(repo, clearStagingResidue("only"));
    expect(existsSync(join(repo, "skills-lock.json"))).toBe(false);
  });

  test("is a no-op when there is nothing to clean", () => {
    const repo = stagedRepo({ solo: { body: "# solo\n" } });
    expect(runInRepo(repo, clearStagingResidue("solo"))).toEqual([]);
  });
});

describe("backfillTreeHash", () => {
  const stubGitHub = (shas: Record<string, string>) => Layer.succeed(GitHub, GitHub.of({ contentsShas: () => Effect.succeed(new Map(Object.entries(shas))) }));

  const run = (lock: LockMeta, layer: Layer.Layer<GitHub>): LockMeta => Effect.runSync(backfillTreeHash(lock).pipe(Effect.provide(layer)));

  test("recovers the git tree hash a project lock omits", () => {
    const result = run({ source: "acme/pack", sourceType: "github", skillPath: "skills/foo/SKILL.md" }, stubGitHub({ foo: "b".repeat(40) }));
    expect(result.sourceType === "github" && result.skillFolderHash).toBe("b".repeat(40));
    expect(upstreamFromLock(result)).toMatchObject({ tracking: { kind: "tree", hash: "b".repeat(40) } });
  });

  test("leaves an already-tracked lock alone", () => {
    const lock: LockMeta = { source: "acme/pack", sourceType: "github", skillPath: "skills/foo/SKILL.md", skillFolderHash: "a".repeat(40) };
    expect(run(lock, stubGitHub({ foo: "b".repeat(40) }))).toBe(lock);
  });

  test("degrades to untracked when the folder is absent upstream", () => {
    const result = run({ source: "acme/pack", sourceType: "github", skillPath: "skills/foo/SKILL.md" }, stubGitHub({ other: "b".repeat(40) }));
    expect(upstreamFromLock(result)).toMatchObject({ tracking: { kind: "untracked" } });
  });

  test("degrades to untracked when GitHub is unreachable", () => {
    const failing = Layer.succeed(GitHub, GitHub.of({ contentsShas: () => Effect.fail(new GitHubError({ message: "offline" })) }));
    const result = run({ source: "acme/pack", sourceType: "github", skillPath: "skills/foo/SKILL.md" }, failing);
    expect(upstreamFromLock(result)).toMatchObject({ tracking: { kind: "untracked" } });
  });
});

describe("findUnindexedSkills", () => {
  test("finds local, vendor, and host agent directories absent from the manifest", () => {
    const repo = mkdtempSync(join(tmpdir(), "slinky-unindexed-"));
    try {
      for (const path of ["skills/indexed", "skills/draft", "vendor/acme/effect", ".agents/skills/manual", "vendor/acme/incomplete"]) {
        mkdirSync(join(repo, path), { recursive: true });
      }
      for (const path of ["skills/indexed", "skills/draft", "vendor/acme/effect", ".agents/skills/manual"]) {
        writeFileSync(join(repo, path, "SKILL.md"), `# ${path}\n`);
      }
      const manifest: Manifest = {
        version: 1,
        skills: {
          indexed: { origin: "local", path: "skills/indexed", contentHash: "a".repeat(64) },
        },
        profiles: {},
      };

      expect(findUnindexedSkills(manifest, repo).map(({ name, origin, path }) => ({ name, origin, path }))).toEqual([
        { name: "manual", origin: "agent", path: ".agents/skills/manual" },
        { name: "draft", origin: "local", path: "skills/draft" },
        { name: "effect", origin: "vendor", path: "vendor/acme/effect" },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
