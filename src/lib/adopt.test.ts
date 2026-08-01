import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptDestination, decodeSkillLock, findUnindexedSkills, upstreamFromLock } from "./adopt.ts";
import type { ForeignSkill } from "./adopt.ts";
import type { Manifest } from "./manifest.ts";

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
    const skills = decodeSkillLock({
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
    });

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
