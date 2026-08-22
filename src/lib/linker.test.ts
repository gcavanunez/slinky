import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { Manifest, ProjectLink, State, version } from "./manifest.ts";
import { applyUnlink, checkLink, isGlobalStoreProject, linkSkill, prepareUnlink, unlinkSkill } from "./linker.ts";
import { HostRepo, hostRepoPaths, Paths, RepoResolution } from "./paths.ts";

const REPO = "/repo";
const HOME = "/home/slinky-test";
const hostLayer = Layer.succeed(HostRepo, HostRepo.of(hostRepoPaths(REPO)));

const pathsLayer = (home: string) =>
  Layer.succeed(
    Paths,
    Paths.of({
      home,
      slinkyConfig: join(home, ".config", "slinky", "config.json"),
      agentsSkills: join(home, ".agents", "skills"),
      claudeSkills: join(home, ".claude", "skills"),
      opencodeSkills: join(home, ".opencode", "skills"),
      skillLock: join(home, ".agents", ".skill-lock.json"),
      resolution: RepoResolution.Found({ repo: REPO }),
      diffPager: undefined,
      editor: undefined,
      editorCommand: ["nvim"],
      saveHostConfig: () => Effect.void,
      saveDiffPager: () => Effect.void,
      saveEditor: () => Effect.void,
    }),
  );

const layersFor = (home: string) => Layer.mergeAll(hostLayer, pathsLayer(home));

const runWithHome = <A, E>(home: string, effect: Effect.Effect<A, E, HostRepo | Paths>): A => Effect.runSync(effect.pipe(Effect.provide(layersFor(home))));

const run = <A, E>(effect: Effect.Effect<A, E, HostRepo | Paths>): A => runWithHome(HOME, effect);

const failureMessageWithHome = <A, E>(home: string, effect: Effect.Effect<A, E, HostRepo | Paths>): string => {
  const exit = Effect.runSyncExit(effect.pipe(Effect.provide(layersFor(home))));
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const error = Cause.squash(exit.cause);
  return error instanceof Error ? error.message : String(error);
};

const failureMessage = <A, E>(effect: Effect.Effect<A, E, HostRepo | Paths>): string => failureMessageWithHome(HOME, effect);

const roots: string[] = [];
const linkExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

function fixtures(project: string) {
  const manifest = Schema.decodeUnknownSync(Manifest)({
    version,
    skills: {
      foo: {
        origin: "local",
        path: "skills/foo",
        contentHash: "a".repeat(64),
      },
    },
    profiles: {},
  });
  const state = Schema.decodeUnknownSync(State)({
    version,
    disabledSkills: [],
    activeProfile: null,
    projectLinks: [
      {
        mode: "symlink",
        project,
        skill: "foo",
        targets: [".agents/skills/foo"],
        excludedTargets: [],
        linkedAt: "2026-07-13T12:00:00.000Z",
      },
    ],
    recentProjects: [],
  });
  const link = state.projectLinks[0];
  if (!link) throw new Error("expected project link fixture");
  return { manifest, state, link };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("link construction", () => {
  test("constructs a project link with a canonical encoded timestamp", () => {
    const project = mkdtempSync(join(tmpdir(), "slinky-link-"));
    roots.push(project);
    const { manifest } = fixtures(project);
    const state = Schema.decodeUnknownSync(State)({
      version,
      disabledSkills: [],
      activeProfile: null,
      projectLinks: [],
      recentProjects: [],
    });

    const result = run(
      linkSkill(manifest, state, {
        skill: "foo",
        project,
        mode: "symlink",
        gitExclude: false,
        claude: false,
      }),
    );
    const encoded = Schema.encodeSync(ProjectLink)(result.link);

    expect(result.state.projectLinks).toEqual([result.link]);
    expect(encoded.linkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(linkExists(join(project, ".agents", "skills", "foo"))).toBe(true);
  });

  test("Git excludes a managed symlink target", () => {
    const project = mkdtempSync(join(tmpdir(), "slinky-link-"));
    roots.push(project);
    expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
    const { manifest } = fixtures(project);
    const state = Schema.decodeUnknownSync(State)({
      version,
      disabledSkills: [],
      activeProfile: null,
      projectLinks: [],
      recentProjects: [],
    });

    run(
      linkSkill(manifest, state, {
        skill: "foo",
        project,
        mode: "symlink",
        gitExclude: true,
        claude: false,
      }),
    );

    const exclude = readFileSync(join(project, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.agents/skills/foo\n");
    expect(exclude).not.toContain("/.agents/skills/foo/\n");
    expect(Bun.spawnSync(["git", "-C", project, "check-ignore", ".agents/skills/foo"]).exitCode).toBe(0);
  });
});

describe("link safety", () => {
  function emptyState() {
    return Schema.decodeUnknownSync(State)({
      version,
      disabledSkills: [],
      activeProfile: null,
      projectLinks: [],
      recentProjects: [],
    });
  }

  test("refuses a project whose .agents/skills is the global store", () => {
    // $HOME: linking here would copy the skill over its own global entry.
    const home = mkdtempSync(join(tmpdir(), "slinky-home-"));
    roots.push(home);
    const { manifest } = fixtures(home);

    const message = failureMessageWithHome(home, linkSkill(manifest, emptyState(), { skill: "foo", project: home, mode: "copy", gitExclude: false, claude: false }));

    expect(message).toContain("is the global skill store");
    expect(linkExists(join(home, ".agents", "skills", "foo"))).toBe(false);
  });

  test("refuses the skills repo itself", () => {
    const { manifest } = fixtures(REPO);

    const message = failureMessage(linkSkill(manifest, emptyState(), { skill: "foo", project: REPO, mode: "copy", gitExclude: false, claude: false }));

    expect(message).toContain("skills repo itself");
  });

  test("allows an ordinary project under the same home", () => {
    const home = mkdtempSync(join(tmpdir(), "slinky-home-"));
    roots.push(home);
    const project = join(home, "work", "app");
    mkdirSync(project, { recursive: true });
    const { manifest } = fixtures(project);

    const result = runWithHome(home, linkSkill(manifest, emptyState(), { skill: "foo", project, mode: "symlink", gitExclude: false, claude: false }));

    expect(result.link.project).toBe(resolve(project));
    expect(linkExists(join(project, ".agents", "skills", "foo"))).toBe(true);
  });

  test("identifies the global store regardless of a symlinked home", () => {
    const real = mkdtempSync(join(tmpdir(), "slinky-realhome-"));
    roots.push(real);
    const alias = join(real, "alias");
    mkdirSync(join(real, "home", ".agents", "skills"), { recursive: true });
    symlinkSync(join(real, "home"), alias);

    expect(isGlobalStoreProject(alias, join(real, "home", ".agents", "skills"))).toBe(true);
    expect(isGlobalStoreProject(join(real, "home", "project"), join(real, "home", ".agents", "skills"))).toBe(false);
  });
});

describe("unlink safety", () => {
  test("refuses to delete a directory that replaced a managed symlink", () => {
    const project = mkdtempSync(join(tmpdir(), "slinky-link-"));
    roots.push(project);
    const target = join(project, ".agents", "skills", "foo");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "user-file.txt"), "keep me");

    const { manifest, state, link } = fixtures(project);

    expect(checkLink(manifest, link, REPO)).toBe("drifted-local");
    expect(failureMessage(unlinkSkill(manifest, state, "foo", project))).toContain("replaced or retargeted");
    expect(existsSync(join(target, "user-file.txt"))).toBe(true);
  });

  test("prepares state before deleting a validated link", () => {
    const project = mkdtempSync(join(tmpdir(), "slinky-link-"));
    roots.push(project);
    const target = join(project, ".agents", "skills", "foo");
    mkdirSync(join(project, ".agents", "skills"), { recursive: true });
    symlinkSync(resolve(REPO, "skills", "foo"), target);

    const { manifest, state } = fixtures(project);

    const prepared = run(prepareUnlink(manifest, state, "foo", project));
    expect(linkExists(target)).toBe(true);
    expect(prepared.state.projectLinks).toEqual([]);

    applyUnlink(prepared.link);
    expect(linkExists(target)).toBe(false);
  });
});
