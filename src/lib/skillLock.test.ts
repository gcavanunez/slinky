import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Layer } from "effect";
import type { Manifest } from "../domain/model.ts";
import { HostRepo, Paths } from "./paths.ts";
import { absorbGlobalSkillLockEntries, ensureHostSkillLock, pruneGlobalSkillLockEntries, readSkillLockFile, restoreGlobalSkillLock, seedGlobalSkillLock } from "./skillLock.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly host: string;
  readonly home: string;
}

function fixture(name: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `slinky-lock-${name}-`));
  roots.push(root);
  const host = join(root, "host");
  const home = join(root, "home");
  mkdirSync(host, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(host, "skills.manifest.json"), "{}\n");
  return { root, host, home };
}

const manifest: Manifest = {
  version: 1,
  skills: {
    effect: {
      origin: "vendor",
      path: "vendor/kitlangton/effect",
      contentHash: "a".repeat(64),
      upstream: {
        kind: "github",
        repository: "kitlangton/skills",
        url: "https://github.com/kitlangton/skills.git",
        tracking: { kind: "tree", path: "skills/effect/SKILL.md", hash: "b".repeat(40) },
      },
      vendoredAt: null,
    },
  },
  profiles: {},
};

const layerFor = (f: Fixture) =>
  HostRepo.layer.pipe(Layer.provideMerge(Paths.layer), Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: f.home, SLINKY_REPO: f.host }))));

const run = <A, E>(f: Fixture, effect: Effect.Effect<A, E, HostRepo | Paths>): A => Effect.runSync(effect.pipe(Effect.provide(layerFor(f))));

describe("committed skill lock", () => {
  test("migrates manifest provenance while retaining compatible global metadata", () => {
    const f = fixture("migrate");
    mkdirSync(join(f.home, ".agents"), { recursive: true });
    writeFileSync(
      join(f.home, ".agents", ".skill-lock.json"),
      `${JSON.stringify({
        version: 3,
        skills: {
          effect: {
            source: "kitlangton/skills",
            sourceType: "github",
            sourceUrl: "https://github.com/kitlangton/skills.git",
            skillPath: "skills/effect/SKILL.md",
            skillFolderHash: "c".repeat(40),
            ref: "main",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      })}\n`,
    );

    run(f, ensureHostSkillLock(manifest));

    const host = readSkillLockFile(join(f.host, ".skill-lock.json"));
    expect(host.skills.effect).toMatchObject({
      source: "kitlangton/skills",
      skillPath: "skills/effect/SKILL.md",
      skillFolderHash: "b".repeat(40),
    });
    expect(host.entries.effect?.ref).toBe("main");
  });

  test("seeds identical managed provenance across different machine locks", () => {
    const first = fixture("first");
    const second = fixture("second");
    const hostLock = {
      version: 3,
      skills: {
        effect: {
          source: "kitlangton/skills",
          sourceType: "github",
          sourceUrl: "https://github.com/kitlangton/skills.git",
          skillPath: "skills/effect/SKILL.md",
          skillFolderHash: "b".repeat(40),
          ref: "main",
        },
      },
    };
    for (const f of [first, second]) writeFileSync(join(f.host, ".skill-lock.json"), `${JSON.stringify(hostLock)}\n`);
    mkdirSync(join(first.home, ".agents"), { recursive: true });
    mkdirSync(join(second.home, ".agents"), { recursive: true });
    writeFileSync(
      join(first.home, ".agents", ".skill-lock.json"),
      `${JSON.stringify({ version: 3, skills: { effect: { source: "wrong/one", sourceType: "github" }, foreign: { source: "/tmp/local", sourceType: "local" } }, dismissed: { notice: true } })}\n`,
    );
    writeFileSync(
      join(second.home, ".agents", ".skill-lock.json"),
      `${JSON.stringify({ version: 3, skills: { effect: { source: "wrong/two", sourceType: "github" } }, lastSelectedAgents: ["claude-code"] })}\n`,
    );

    run(first, seedGlobalSkillLock(manifest, ["effect"]));
    run(second, seedGlobalSkillLock(manifest, ["effect"]));

    const firstGlobal = JSON.parse(readFileSync(join(first.home, ".agents", ".skill-lock.json"), "utf8"));
    const secondGlobal = JSON.parse(readFileSync(join(second.home, ".agents", ".skill-lock.json"), "utf8"));
    expect(firstGlobal.skills.effect).toEqual(secondGlobal.skills.effect);
    expect(firstGlobal.skills.foreign.sourceType).toBe("local");
    expect(firstGlobal.dismissed.notice).toBe(true);
    expect(secondGlobal.lastSelectedAgents).toEqual(["claude-code"]);
  });

  test("prunes retired catalog provenance without changing foreign skills or preferences", () => {
    const f = fixture("prune");
    mkdirSync(join(f.home, ".agents"), { recursive: true });
    writeFileSync(
      join(f.home, ".agents", ".skill-lock.json"),
      `${JSON.stringify({
        version: 3,
        skills: {
          effect: {
            source: "kitlangton/skills",
            sourceType: "github",
            sourceUrl: "https://github.com/kitlangton/skills.git",
            skillPath: "skills/effect/SKILL.md",
            skillFolderHash: "b".repeat(40),
          },
          foreign: { source: "/tmp/local", sourceType: "local" },
        },
        lastSelectedAgents: ["claude-code"],
      })}\n`,
    );

    const oldEntries = readSkillLockFile(join(f.home, ".agents", ".skill-lock.json")).entries;
    run(f, pruneGlobalSkillLockEntries(manifest, oldEntries, ["effect"]));

    const global = JSON.parse(readFileSync(join(f.home, ".agents", ".skill-lock.json"), "utf8"));
    expect(global.skills.effect).toBeUndefined();
    expect(global.skills.foreign.sourceType).toBe("local");
    expect(global.lastSelectedAgents).toEqual(["claude-code"]);
  });

  test("preserves same-named machine provenance that does not belong to the retired catalog skill", () => {
    const f = fixture("prune-mismatch");
    mkdirSync(join(f.home, ".agents"), { recursive: true });
    writeFileSync(
      join(f.home, ".agents", ".skill-lock.json"),
      `${JSON.stringify({ version: 3, skills: { effect: { source: "someone/else", sourceType: "github", skillFolderHash: "c".repeat(40) } } })}\n`,
    );

    const oldEntries = {
      effect: {
        source: "kitlangton/skills",
        sourceType: "github",
        sourceUrl: "https://github.com/kitlangton/skills.git",
        skillPath: "skills/effect/SKILL.md",
        skillFolderHash: "b".repeat(40),
      },
    };
    run(f, pruneGlobalSkillLockEntries(manifest, oldEntries, ["effect"]));

    const global = JSON.parse(readFileSync(join(f.home, ".agents", ".skill-lock.json"), "utf8"));
    expect(global.skills.effect.source).toBe("someone/else");
  });

  test("restores the exact machine lock contents from a snapshot", () => {
    const f = fixture("restore");
    mkdirSync(join(f.home, ".agents"), { recursive: true });
    const path = join(f.home, ".agents", ".skill-lock.json");
    const original = `${JSON.stringify({ version: 3, skills: { foreign: { source: "/tmp/local", sourceType: "local" } }, dismissed: { notice: true } })}\n`;
    writeFileSync(path, original);
    const snapshot = readSkillLockFile(path);
    writeFileSync(path, `${JSON.stringify({ version: 3, skills: {} }, null, 2)}\n`);

    run(f, restoreGlobalSkillLock(snapshot));

    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("absorbs an accepted update before the manifest and host hashes agree", () => {
    const f = fixture("accept");
    mkdirSync(join(f.home, ".agents"), { recursive: true });
    const oldEntry = {
      source: "kitlangton/skills",
      sourceType: "github",
      sourceUrl: "https://github.com/kitlangton/skills.git",
      skillPath: "skills/effect/SKILL.md",
      skillFolderHash: "b".repeat(40),
    };
    const newEntry = { ...oldEntry, skillFolderHash: "c".repeat(40), updatedAt: "2026-08-18T00:00:00.000Z" };
    writeFileSync(join(f.host, ".skill-lock.json"), `${JSON.stringify({ version: 3, skills: { effect: oldEntry } })}\n`);
    writeFileSync(join(f.home, ".agents", ".skill-lock.json"), `${JSON.stringify({ version: 3, skills: { effect: newEntry } })}\n`);
    const effect = manifest.skills.effect;
    if (!effect || effect.origin !== "vendor") throw new Error("expected effect vendor fixture");
    const updatedManifest: Manifest = {
      ...manifest,
      skills: {
        effect: {
          ...effect,
          upstream: {
            kind: "github",
            repository: "kitlangton/skills",
            url: "https://github.com/kitlangton/skills.git",
            tracking: { kind: "tree", path: "skills/effect/SKILL.md", hash: "c".repeat(40) },
          },
        },
      },
    };

    run(f, absorbGlobalSkillLockEntries(updatedManifest, ["effect"]));

    expect(readSkillLockFile(join(f.host, ".skill-lock.json")).skills.effect?.skillFolderHash).toBe("c".repeat(40));
  });
});
