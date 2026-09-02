import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { pullCatalog, saveCatalog } from "./convergence.ts";
import { contentHash } from "./hash.ts";
import { ManifestStore } from "./manifest.ts";
import { HostRepo, Paths } from "./paths.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly host: string;
  readonly home: string;
  readonly statePath: string;
  readonly globalLockPath: string;
  readonly agentsRetired: string;
  readonly claudeRetired: string;
}

const lockEntry = {
  source: "acme/skills",
  sourceType: "github",
  sourceUrl: "https://github.com/acme/skills.git",
  skillPath: "skills/retired",
  skillFolderHash: "b".repeat(40),
};

function git(repo: string, args: ReadonlyArray<string>): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

function fixture(linkedSkill = "kept"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "slinky-convergence-"));
  roots.push(root);
  const host = join(root, "host");
  const home = join(root, "home");
  const retiredRepo = join(host, "vendor", "acme", "retired");
  const keptRepo = join(host, "skills", "kept");
  mkdirSync(retiredRepo, { recursive: true });
  mkdirSync(keptRepo, { recursive: true });
  writeFileSync(join(retiredRepo, "SKILL.md"), "# retired\n");
  writeFileSync(join(keptRepo, "SKILL.md"), "# kept\n");

  const manifest = {
    version: 1,
    skills: {
      retired: {
        origin: "vendor",
        path: "vendor/acme/retired",
        contentHash: contentHash(retiredRepo),
        upstream: {
          kind: "github",
          repository: "acme/skills",
          url: "https://github.com/acme/skills.git",
          tracking: { kind: "tree", path: "skills/retired", hash: "b".repeat(40) },
        },
        vendoredAt: null,
      },
      kept: { origin: "local", path: "skills/kept", contentHash: contentHash(keptRepo) },
    },
    profiles: { focus: ["retired"] },
  };
  writeFileSync(join(host, "skills.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(host, ".skill-lock.json"), `${JSON.stringify({ version: 3, skills: { retired: lockEntry } }, null, 2)}\n`);
  writeFileSync(join(host, ".gitignore"), ".local/\n");

  const statePath = join(host, ".local", "state.json");
  mkdirSync(join(host, ".local"), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        disabledSkills: ["kept"],
        activeProfile: "focus",
        projectLinks: [
          {
            mode: "symlink",
            project: "/tmp/project",
            skill: linkedSkill,
            targets: [`.agents/skills/${linkedSkill}`],
            excludedTargets: [],
            linkedAt: "2026-09-02T12:00:00.000Z",
          },
        ],
        recentProjects: ["/tmp/project"],
      },
      null,
      2,
    )}\n`,
  );

  git(host, ["init", "-q"]);
  git(host, ["config", "user.name", "Slinky Test"]);
  git(host, ["config", "user.email", "slinky@example.com"]);
  git(host, ["add", "."]);
  git(host, ["commit", "-qm", "Initial catalog"]);

  const agentsRetired = join(home, ".agents", "skills", "retired");
  const claudeRetired = join(home, ".claude", "skills", "retired");
  mkdirSync(agentsRetired, { recursive: true });
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  writeFileSync(join(agentsRetired, "SKILL.md"), "# retired\n");
  symlinkSync(join("..", "..", ".agents", "skills", "retired"), claudeRetired);
  const globalLockPath = join(home, ".agents", ".skill-lock.json");
  writeFileSync(
    globalLockPath,
    `${JSON.stringify({ version: 3, skills: { retired: lockEntry, foreign: { source: "/tmp/foreign", sourceType: "local" } }, dismissed: { notice: true } })}\n`,
  );

  return { root, host, home, statePath, globalLockPath, agentsRetired, claudeRetired };
}

function retireSkill(f: Fixture): void {
  retireRepo(f.host);
}

function retireProfile(repo: string): void {
  const manifest = JSON.parse(readFileSync(join(repo, "skills.manifest.json"), "utf8"));
  manifest.profiles = {};
  writeFileSync(join(repo, "skills.manifest.json"), `${JSON.stringify(manifest)}\n`);
}

function retireRepo(repo: string): void {
  const manifest = JSON.parse(readFileSync(join(repo, "skills.manifest.json"), "utf8"));
  delete manifest.skills.retired;
  manifest.profiles = {};
  writeFileSync(join(repo, "skills.manifest.json"), `${JSON.stringify(manifest)}\n`);
  rmSync(join(repo, "vendor", "acme", "retired"), { recursive: true });
}

const layerFor = (f: Fixture) =>
  ManifestStore.layer.pipe(
    Layer.provideMerge(HostRepo.layer),
    Layer.provideMerge(Paths.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: f.home, SLINKY_REPO: f.host }))),
  );

const runSave = (f: Fixture) => Effect.runSyncExit(saveCatalog({ message: "Retire skill" }).pipe(Effect.provide(layerFor(f))));

function runSaveWithFinalRevisionFailure(f: Fixture) {
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git is required");
  const bin = join(f.root, "failing-git");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
if [ "$1" = "--literal-pathspecs" ] && [ "$2" = "rev-parse" ] && [ "$3" = "--short" ]; then
  exit 71
fi
exec "${realGit}" "$@"
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  try {
    return runSave(f);
  } finally {
    process.env.PATH = originalPath;
  }
}

function publishRetirement(f: Fixture): void {
  const remote = join(f.root, "remote.git");
  git(f.host, ["init", "--bare", "-q", remote]);
  git(f.host, ["branch", "-M", "main"]);
  git(f.host, ["remote", "add", "origin", remote]);
  git(f.host, ["push", "-qu", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const publisher = join(f.root, "publisher");
  git(f.root, ["clone", "-q", remote, publisher]);
  git(publisher, ["config", "user.name", "Slinky Test"]);
  git(publisher, ["config", "user.email", "slinky@example.com"]);
  retireRepo(publisher);
  writeFileSync(join(publisher, ".skill-lock.json"), `${JSON.stringify({ version: 3, skills: {} })}\n`);
  git(publisher, ["add", "-A"]);
  git(publisher, ["commit", "-qm", "Retire skill remotely"]);
  git(publisher, ["push", "-q"]);
}

function runPullWithMergeFailure(f: Fixture) {
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git is required");
  const bin = join(f.root, "failing-merge-git");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
if [ "$1" = "--literal-pathspecs" ] && [ "$2" = "merge" ] && [ "$3" = "--ff-only" ]; then
  exit 72
fi
exec "${realGit}" "$@"
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  try {
    return Effect.runSyncExit(pullCatalog().pipe(Effect.provide(layerFor(f))));
  } finally {
    process.env.PATH = originalPath;
  }
}

function failureMessage(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const error = Cause.squash(exit.cause);
  return error instanceof Error ? error.message : String(error);
}

describe("local catalog retirement", () => {
  test("presentation event failures do not fail catalog operations", () => {
    const f = fixture();
    const exit = Effect.runSyncExit(
      saveCatalog({
        onEvent: () => {
          throw new Error("renderer unavailable");
        },
      }).pipe(Effect.provide(layerFor(f))),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("restores Git, state, global locks, and retired globals when Git fails after committing", () => {
    const f = fixture();
    writeFileSync(join(f.host, "notes.txt"), "keep staged\n");
    git(f.host, ["add", "notes.txt"]);
    retireSkill(f);

    const before = {
      head: git(f.host, ["rev-parse", "HEAD"]),
      index: git(f.host, ["diff", "--cached", "--binary"]),
      worktree: git(f.host, ["diff", "--binary"]),
      status: git(f.host, ["status", "--porcelain"]),
      manifest: readFileSync(join(f.host, "skills.manifest.json")),
      hostLock: readFileSync(join(f.host, ".skill-lock.json")),
      state: readFileSync(f.statePath),
      globalLock: readFileSync(f.globalLockPath),
      liveSkill: readFileSync(join(f.agentsRetired, "SKILL.md")),
      claudeTarget: readlinkSync(f.claudeRetired),
    };

    const exit = runSaveWithFinalRevisionFailure(f);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(git(f.host, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(git(f.host, ["diff", "--cached", "--binary"])).toBe(before.index);
    expect(git(f.host, ["diff", "--binary"])).toBe(before.worktree);
    expect(git(f.host, ["status", "--porcelain"])).toBe(before.status);
    expect(readFileSync(join(f.host, "skills.manifest.json"))).toEqual(before.manifest);
    expect(readFileSync(join(f.host, ".skill-lock.json"))).toEqual(before.hostLock);
    expect(readFileSync(f.statePath)).toEqual(before.state);
    expect(readFileSync(f.globalLockPath)).toEqual(before.globalLock);
    expect(lstatSync(f.agentsRetired).isDirectory()).toBe(true);
    expect(readFileSync(join(f.agentsRetired, "SKILL.md"))).toEqual(before.liveSkill);
    expect(lstatSync(f.claudeRetired).isSymbolicLink()).toBe(true);
    expect(readlinkSync(f.claudeRetired)).toBe(before.claudeTarget);
  });

  test("keeps v1 disabled-skill intent when its active profile is retired", () => {
    const f = fixture();
    retireSkill(f);

    const exit = runSave(f);

    if (Exit.isFailure(exit)) throw new Error(failureMessage(exit));
    expect(exit.value.changed).toBe(true);
    expect(JSON.parse(readFileSync(f.statePath, "utf8"))).toMatchObject({
      version: 2,
      selection: { kind: "custom", disabledSkills: ["kept"] },
      projectLinks: [{ skill: "kept", project: "/tmp/project" }],
    });
    expect(existsSync(f.agentsRetired)).toBe(false);
    expect(existsSync(f.claudeRetired)).toBe(false);
    expect(JSON.parse(readFileSync(f.globalLockPath, "utf8")).skills).toEqual({ foreign: { source: "/tmp/foreign", sourceType: "local" } });
  });

  test("persists disabled intent when only an active v2 profile is retired", () => {
    const f = fixture();
    writeFileSync(f.statePath, `${JSON.stringify({ version: 2, selection: { kind: "profile", name: "focus" }, projectLinks: [], recentProjects: [] })}\n`);
    retireProfile(f.host);

    const exit = runSave(f);

    if (Exit.isFailure(exit)) throw new Error(failureMessage(exit));
    expect(JSON.parse(readFileSync(f.statePath, "utf8")).selection).toEqual({ kind: "custom", disabledSkills: ["kept"] });
  });

  test("blocks project links to a removed skill before cleanup", () => {
    const f = fixture("retired");
    retireSkill(f);
    const stateBefore = readFileSync(f.statePath);

    const exit = runSave(f);

    expect(failureMessage(exit)).toContain("catalog changes remove linked skills; unlink them before saving");
    expect(readFileSync(f.statePath)).toEqual(stateBefore);
    expect(lstatSync(f.agentsRetired).isDirectory()).toBe(true);
    expect(lstatSync(f.claudeRetired).isSymbolicLink()).toBe(true);
  });

  test("migrates v1 disabled-skill intent against an incoming manifest", () => {
    const f = fixture();
    publishRetirement(f);

    const exit = Effect.runSyncExit(pullCatalog().pipe(Effect.provide(layerFor(f))));

    if (Exit.isFailure(exit)) throw new Error(failureMessage(exit));
    expect(exit.value.state.selection).toEqual({ kind: "custom", disabledSkills: ["kept"] });
    expect(JSON.parse(readFileSync(f.statePath, "utf8")).selection).toEqual({ kind: "custom", disabledSkills: ["kept"] });
  }, 30_000);

  test("restores state, locks, and retired globals when a fast-forward fails", () => {
    const f = fixture();
    publishRetirement(f);
    const before = {
      head: git(f.host, ["rev-parse", "HEAD"]),
      status: git(f.host, ["status", "--porcelain"]),
      state: readFileSync(f.statePath),
      globalLock: readFileSync(f.globalLockPath),
      liveSkill: readFileSync(join(f.agentsRetired, "SKILL.md")),
      claudeTarget: readlinkSync(f.claudeRetired),
    };

    const exit = runPullWithMergeFailure(f);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(git(f.host, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(git(f.host, ["status", "--porcelain"])).toBe(before.status);
    expect(readFileSync(f.statePath)).toEqual(before.state);
    expect(readFileSync(f.globalLockPath)).toEqual(before.globalLock);
    expect(readFileSync(join(f.agentsRetired, "SKILL.md"))).toEqual(before.liveSkill);
    expect(readlinkSync(f.claudeRetired)).toBe(before.claudeTarget);
  }, 30_000);
});
