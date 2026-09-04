import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer } from "effect";
import { ManifestFileError, OperationFailed } from "../domain/model.ts";
import { adoptDestination, adoptSkills, backfillTreeHash, clearStagingResidue, findStaged, findUnindexedSkills } from "./adopt.ts";
import type { AdoptionPersistenceStage, AdoptionTransactionHooks, ForeignSkill } from "./adopt.ts";
import { decodeSkillLock, upstreamFromLock } from "./skill-lock.ts";
import type { LockMeta } from "./skill-lock.ts";
import type { Manifest, State } from "../domain/model.ts";
import { ManifestStore } from "./manifest.ts";
import type { ManifestStoreInterface } from "./manifest.ts";
import { contentHash } from "./hash.ts";
import { HostRepo, hostRepoPaths, Paths, RepoResolution } from "./paths.ts";
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

  test("preserves an unowned dangling claude symlink", () => {
    const repo = stagedRepo({ gone: { body: "# gone\n" } });
    const link = join(repo, ".claude", "skills", "gone");
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    symlinkSync("/unowned/missing", link);

    runInRepo(repo, clearStagingResidue("gone"));

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
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

describe("adoptSkills transaction", () => {
  const stages: AdoptionPersistenceStage[] = ["manifest-save", "state-save", "lock-save"];

  for (const failedStage of stages) {
    test(`restores manifest, state, lock, and files after ${failedStage} failure`, () => {
      const repo = mkdtempSync(join(tmpdir(), "slinky-adoption-transaction-"));
      const home = mkdtempSync(join(tmpdir(), "slinky-adoption-home-"));
      roots.push(repo, home);
      const paths = hostRepoPaths(repo);
      const source = join(paths.stagedSkills, "fresh");
      const destination = join(repo, "vendor", "_unknown", "fresh");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "SKILL.md"), "# fresh\n");

      const previousManifest: Manifest = { version: 1, skills: {}, profiles: { focused: [] } };
      const previousState: State = {
        version: 2,
        selection: { kind: "profile", name: "focused" },
        projectLinks: [],
        recentProjects: ["/previous/project"],
      };
      const previousLock = {
        version: 3,
        skills: {
          legacy: {
            source: "acme/legacy",
            sourceType: "github",
            skillPath: "skills/legacy/SKILL.md",
            skillFolderHash: "a".repeat(40),
          },
        },
      };
      writeFileSync(paths.manifestPath, `${JSON.stringify(previousManifest, null, 2)}\n`);
      mkdirSync(join(repo, ".local"), { recursive: true });
      writeFileSync(paths.statePath, `${JSON.stringify(previousState, null, 2)}\n`);
      writeFileSync(paths.catalogLock, `${JSON.stringify(previousLock, null, 2)}\n`);

      let injected = false;
      const hooks: AdoptionTransactionHooks = {
        afterPersist: (stage) => {
          if (stage !== failedStage || injected) return Effect.void;
          injected = true;
          return Effect.fail(new OperationFailed({ message: `injected ${stage} failure` }));
        },
      };
      const hostLayer = Layer.succeed(HostRepo, HostRepo.of(paths));
      const pathsLayer = Layer.succeed(
        Paths,
        Paths.of({
          home,
          slinkyConfig: join(home, ".config", "slinky", "config.json"),
          agentsSkills: join(home, ".agents", "skills"),
          claudeSkills: join(home, ".claude", "skills"),
          opencodeSkills: join(home, ".opencode", "skills"),
          skillLock: join(home, ".agents", ".skill-lock.json"),
          resolution: RepoResolution.Found({ repo }),
          diffPager: undefined,
          editor: undefined,
          editorCommand: ["nvim"],
          theme: undefined,
          saveHostConfig: () => Effect.void,
          saveDiffPager: () => Effect.void,
          saveEditor: () => Effect.void,
          saveTheme: () => Effect.void,
        }),
      );
      const storeLayer = ManifestStore.layer.pipe(Layer.provide(hostLayer));
      const githubLayer = Layer.succeed(GitHub, GitHub.of({ contentsShas: () => Effect.succeed(new Map()) }));
      const layer = Layer.mergeAll(hostLayer, pathsLayer, storeLayer, githubLayer);
      const effect = Effect.gen(function* () {
        const store = yield* ManifestStore;
        return yield* adoptSkills(store, previousManifest, previousState, [{ candidate: { name: "fresh", location: "staged", dir: source } }], hooks);
      });

      const manifestBefore = readFileSync(paths.manifestPath, "utf8");
      const exit = Effect.runSyncExit(effect.pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(injected).toBe(true);
      expect(readFileSync(paths.manifestPath, "utf8")).toBe(manifestBefore);
      expect(JSON.parse(readFileSync(paths.statePath, "utf8"))).toEqual(previousState);
      expect(JSON.parse(readFileSync(paths.catalogLock, "utf8"))).toEqual(previousLock);
      expect(existsSync(source)).toBe(true);
      expect(existsSync(destination)).toBe(false);
    });
  }

  test.each([
    { name: "absent", contents: null },
    {
      name: "v1",
      contents: `${JSON.stringify({ version: 1, disabledSkills: [], activeProfile: null, projectLinks: [], recentProjects: [] })}\n`,
    },
  ])("restores the exact $name state persistence after failure", ({ contents }) => {
    const repo = mkdtempSync(join(tmpdir(), "slinky-adoption-state-snapshot-"));
    const home = mkdtempSync(join(tmpdir(), "slinky-adoption-state-home-"));
    roots.push(repo, home);
    const hostPaths = hostRepoPaths(repo);
    const source = join(hostPaths.stagedSkills, "fresh");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "# fresh\n");
    const previousManifest: Manifest = { version: 1, skills: {}, profiles: {} };
    writeFileSync(hostPaths.manifestPath, `${JSON.stringify(previousManifest)}\n`);
    writeFileSync(hostPaths.catalogLock, `${JSON.stringify({ version: 3, skills: {} })}\n`);
    if (contents !== null) {
      mkdirSync(join(repo, ".local"), { recursive: true });
      writeFileSync(hostPaths.statePath, contents);
    }
    const hostLayer = Layer.succeed(HostRepo, HostRepo.of(hostPaths));
    const pathsLayer = Layer.succeed(
      Paths,
      Paths.of({
        home,
        slinkyConfig: join(home, ".config", "slinky", "config.json"),
        agentsSkills: join(home, ".agents", "skills"),
        claudeSkills: join(home, ".claude", "skills"),
        opencodeSkills: join(home, ".opencode", "skills"),
        skillLock: join(home, ".agents", ".skill-lock.json"),
        resolution: RepoResolution.Found({ repo }),
        diffPager: undefined,
        editor: undefined,
        editorCommand: ["nvim"],
        theme: undefined,
        saveHostConfig: () => Effect.void,
        saveDiffPager: () => Effect.void,
        saveEditor: () => Effect.void,
        saveTheme: () => Effect.void,
      }),
    );
    const storeLayer = ManifestStore.layer.pipe(Layer.provide(hostLayer));
    const githubLayer = Layer.succeed(GitHub, GitHub.of({ contentsShas: () => Effect.succeed(new Map()) }));
    const hooks: AdoptionTransactionHooks = {
      afterPersist: (stage) => (stage === "state-save" ? Effect.fail(new OperationFailed({ message: "forward failure" })) : Effect.void),
    };
    const exit = Effect.runSyncExit(
      Effect.gen(function* () {
        const store = yield* ManifestStore;
        const previousState = yield* store.loadState(previousManifest);
        return yield* adoptSkills(store, previousManifest, previousState, [{ candidate: { name: "fresh", location: "staged", dir: source } }], hooks);
      }).pipe(Effect.provide(Layer.mergeAll(hostLayer, pathsLayer, storeLayer, githubLayer))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (contents === null) expect(existsSync(hostPaths.statePath)).toBe(false);
    else expect(readFileSync(hostPaths.statePath, "utf8")).toBe(contents);
  });

  test("reports a rollback failure instead of hiding partial compensation", () => {
    const repo = mkdtempSync(join(tmpdir(), "slinky-adoption-rollback-"));
    const home = mkdtempSync(join(tmpdir(), "slinky-adoption-rollback-home-"));
    roots.push(repo, home);
    const paths = hostRepoPaths(repo);
    const source = join(paths.stagedSkills, "fresh");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "# fresh\n");
    writeFileSync(paths.catalogLock, `${JSON.stringify({ version: 3, skills: {} })}\n`);
    const previousManifest: Manifest = { version: 1, skills: {}, profiles: {} };
    const previousState: State = { version: 2, selection: { kind: "custom", disabledSkills: [] }, projectLinks: [], recentProjects: [] };
    let manifestSaves = 0;
    const store = {
      loadManifest: () => Effect.succeed(previousManifest),
      snapshotManifestFile: () => Effect.succeed({ contents: "{}\n" }),
      restoreManifestFile: () => {
        manifestSaves += 1;
        return manifestSaves === 2 ? Effect.fail(new ManifestFileError(paths.manifestPath, "write", "rollback failed")) : Effect.void;
      },
      loadState: () => Effect.succeed(previousState),
      loadStateForTransition: () => Effect.succeed(previousState),
      snapshotStateFile: () => Effect.succeed({ contents: null }),
      restoreStateFile: () => Effect.void,
      saveManifest: () => {
        manifestSaves += 1;
        return Effect.void;
      },
      saveState: () => Effect.void,
    } satisfies ManifestStoreInterface;
    const hostLayer = Layer.succeed(HostRepo, HostRepo.of(paths));
    const pathsLayer = Layer.succeed(
      Paths,
      Paths.of({
        home,
        slinkyConfig: join(home, ".config", "slinky", "config.json"),
        agentsSkills: join(home, ".agents", "skills"),
        claudeSkills: join(home, ".claude", "skills"),
        opencodeSkills: join(home, ".opencode", "skills"),
        skillLock: join(home, ".agents", ".skill-lock.json"),
        resolution: RepoResolution.Found({ repo }),
        diffPager: undefined,
        editor: undefined,
        editorCommand: ["nvim"],
        theme: undefined,
        saveHostConfig: () => Effect.void,
        saveDiffPager: () => Effect.void,
        saveEditor: () => Effect.void,
        saveTheme: () => Effect.void,
      }),
    );
    const githubLayer = Layer.succeed(GitHub, GitHub.of({ contentsShas: () => Effect.succeed(new Map()) }));
    const hooks: AdoptionTransactionHooks = {
      afterPersist: (stage) => (stage === "manifest-save" ? Effect.fail(new OperationFailed({ message: "forward failure" })) : Effect.void),
    };

    const exit = Effect.runSyncExit(
      adoptSkills(store, previousManifest, previousState, [{ candidate: { name: "fresh", location: "staged", dir: source } }], hooks).pipe(
        Effect.provide(Layer.mergeAll(hostLayer, pathsLayer, githubLayer)),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("compensation also failed: manifest:");
    expect(existsSync(join(repo, "vendor", "_unknown", "fresh"))).toBe(true);
  });
});
