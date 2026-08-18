import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { acceptVendorDrift, applyProfile, linkProjectSkill, restoreVendorDrift, setSkillsEnabled, unlinkProjectSkill } from "./catalogActions.ts";
import { contentHash } from "./hash.ts";
import { ManifestStore } from "./manifest.ts";
import { HostRepo, Paths } from "./paths.ts";

const roots: string[] = [];
const version = 1;

interface Fixture {
  readonly root: string;
  readonly host: string;
  readonly home: string;
  readonly statePath: string;
}

interface VendorPaths {
  readonly baseline: string;
  readonly live: string;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(disabledSkills: ReadonlyArray<string> = []): Fixture {
  const root = mkdtempSync(join(tmpdir(), "slinky-catalog-actions-"));
  roots.push(root);
  const host = join(root, "host");
  const home = join(root, "home");
  const statePath = join(host, ".local", "state.json");
  mkdirSync(join(host, ".local"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const name of ["foo", "bar", "baz"]) {
    mkdirSync(join(host, "skills", name), { recursive: true });
    writeFileSync(join(host, "skills", name, "SKILL.md"), `# ${name}\n`);
  }
  writeFileSync(
    join(host, "skills.manifest.json"),
    `${JSON.stringify({
      version,
      skills: {
        foo: { origin: "local", path: "skills/foo", contentHash: "a".repeat(64) },
        bar: { origin: "local", path: "skills/bar", contentHash: "b".repeat(64) },
        baz: { origin: "local", path: "skills/baz", contentHash: "c".repeat(64) },
      },
      profiles: { focus: ["foo", "baz"], solo: ["foo"] },
    })}\n`,
  );
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        version,
        disabledSkills,
        activeProfile: null,
        projectLinks: [],
        recentProjects: [],
      },
      null,
      2,
    )}\n`,
  );
  return { root, host, home, statePath };
}

const layerFor = (f: Fixture) =>
  ManifestStore.layer.pipe(
    Layer.provideMerge(HostRepo.layer),
    Layer.provideMerge(Paths.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: f.home, SLINKY_REPO: f.host }))),
  );

const run = <A, E>(f: Fixture, effect: Effect.Effect<A, E, ManifestStore | HostRepo | Paths>): Exit.Exit<A, unknown> =>
  Effect.runSyncExit(effect.pipe(Effect.provide(layerFor(f))));

const success = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got: ${Cause.squash(exit.cause)}`);
  return exit.value;
};

const failureMessage = <A>(exit: Exit.Exit<A, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const error = Cause.squash(exit.cause);
  return error instanceof Error ? error.message : String(error);
};

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function installGlobal(f: Fixture, name: string): void {
  mkdirSync(join(f.home, ".agents", "skills"), { recursive: true });
  mkdirSync(join(f.home, ".claude", "skills"), { recursive: true });
  symlinkSync(join(f.host, "skills", name), join(f.home, ".agents", "skills", name));
  symlinkSync(join("..", "..", ".agents", "skills", name), join(f.home, ".claude", "skills", name));
}

function installDriftingVendor(f: Fixture, name = "vendored"): VendorPaths {
  const baseline = join(f.host, "vendor", "example", name);
  const live = join(f.home, ".agents", "skills", name);
  mkdirSync(baseline, { recursive: true });
  mkdirSync(live, { recursive: true });
  writeFileSync(join(baseline, "SKILL.md"), "baseline\n");
  writeFileSync(join(live, "SKILL.md"), "live\n");

  const manifestPath = join(f.host, "skills.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.skills[name] = {
    origin: "vendor",
    path: `vendor/example/${name}`,
    contentHash: contentHash(baseline),
    upstream: { kind: "unknown", note: null },
    vendoredAt: null,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { baseline, live };
}

function state(f: Fixture): {
  disabledSkills: string[];
  activeProfile: string | null;
  projectLinks: Array<{ skill: string; project: string; targets: string[] }>;
} {
  return JSON.parse(readFileSync(f.statePath, "utf8"));
}

describe("catalog actions", () => {
  test("batch disable persists every selected skill and reconciles them together", () => {
    const f = fixture();
    for (const name of ["foo", "bar", "baz"]) installGlobal(f, name);
    rmSync(join(f.home, ".claude", "skills", "baz"));

    const result = success(run(f, setSkillsEnabled(["foo", "bar"], false)));

    expect(result).toEqual({
      messages: ["removed ~/.claude/skills/foo", "removed ~/.claude/skills/bar", "removed ~/.agents/skills/foo", "removed ~/.agents/skills/bar", "linked ~/.claude/skills/baz"],
      warnings: [],
      dryRun: false,
    });
    expect(state(f).disabledSkills).toEqual(["bar", "foo"]);
    expect(pathExists(join(f.home, ".agents", "skills", "foo"))).toBe(false);
    expect(pathExists(join(f.home, ".agents", "skills", "bar"))).toBe(false);
    expect(pathExists(join(f.home, ".agents", "skills", "baz"))).toBe(true);
    expect(pathExists(join(f.home, ".claude", "skills", "baz"))).toBe(true);
  });

  test("batch enable persists every selected skill and materializes global entries", () => {
    const f = fixture(["foo", "bar"]);
    installGlobal(f, "baz");

    success(run(f, setSkillsEnabled(["foo", "bar"], true)));

    expect(state(f).disabledSkills).toEqual([]);
    for (const name of ["foo", "bar"]) {
      expect(lstatSync(join(f.home, ".agents", "skills", name)).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(f.home, ".claude", "skills", name)).isSymbolicLink()).toBe(true);
    }
  });

  test("rejects every unknown skill before state or filesystem mutation", () => {
    const f = fixture();
    installGlobal(f, "foo");
    const before = readFileSync(f.statePath);

    const message = failureMessage(run(f, setSkillsEnabled(["foo", "missing"], false)));

    expect(message).toContain("unknown skill: missing");
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(pathExists(join(f.home, ".agents", "skills", "foo"))).toBe(true);
    expect(pathExists(join(f.home, ".claude", "skills", "foo"))).toBe(true);
  });

  test("profile application persists its exact disabled complement", () => {
    const f = fixture();
    for (const name of ["foo", "bar", "baz"]) installGlobal(f, name);

    success(run(f, applyProfile("focus")));

    expect(state(f).disabledSkills).toEqual(["bar"]);
    expect(state(f).activeProfile).toBe("focus");
    expect(pathExists(join(f.home, ".agents", "skills", "foo"))).toBe(true);
    expect(pathExists(join(f.home, ".agents", "skills", "bar"))).toBe(false);
    expect(pathExists(join(f.home, ".agents", "skills", "baz"))).toBe(true);
  });

  test("dry-run mutations return prospective actions without changing state or stores", () => {
    const f = fixture(["foo"]);
    const before = readFileSync(f.statePath);

    const previews = [
      success(run(f, setSkillsEnabled(["foo"], true, { dryRun: true }))),
      success(run(f, setSkillsEnabled(["bar"], false, { dryRun: true }))),
      success(run(f, applyProfile("focus", { dryRun: true }))),
    ];

    expect(previews).toHaveLength(3);
    for (const preview of previews) {
      expect(preview.dryRun).toBe(true);
      expect(preview.messages.length).toBeGreaterThan(0);
    }
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(existsSync(join(f.home, ".agents"))).toBe(false);
    expect(existsSync(join(f.home, ".claude"))).toBe(false);
  });

  test("accepting vendor drift persists the live copy as the new baseline", () => {
    const f = fixture();
    const paths = installDriftingVendor(f);

    const result = success(run(f, acceptVendorDrift("vendored")));

    expect(result.changed).toBe(true);
    expect(readFileSync(join(paths.baseline, "SKILL.md"), "utf8")).toBe("live\n");
    const manifest = JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8"));
    expect(manifest.skills.vendored.contentHash).toBe(contentHash(paths.live));
  });

  test("restoring vendor drift replaces the live copy with the repo baseline", () => {
    const f = fixture();
    const paths = installDriftingVendor(f);

    success(run(f, restoreVendorDrift("vendored")));

    expect(readFileSync(join(paths.live, "SKILL.md"), "utf8")).toBe("baseline\n");
  });

  test("successful link persists one project link and creates every target", () => {
    const f = fixture();
    const project = join(f.root, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });

    success(run(f, linkProjectSkill({ skill: "foo", project, mode: "symlink", gitExclude: false })));

    const persisted = state(f);
    expect(persisted.projectLinks).toHaveLength(1);
    expect(persisted.projectLinks[0]).toMatchObject({
      skill: "foo",
      project,
      targets: [".agents/skills/foo", ".claude/skills/foo"],
    });
    expect(pathExists(join(project, ".agents", "skills", "foo"))).toBe(true);
    expect(pathExists(join(project, ".claude", "skills", "foo"))).toBe(true);
  });

  test("successful unlink removes every target and its persisted project link", () => {
    const f = fixture();
    const project = join(f.root, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    success(run(f, linkProjectSkill({ skill: "foo", project, mode: "symlink", gitExclude: false })));

    success(run(f, unlinkProjectSkill("foo", project)));

    expect(state(f).projectLinks).toEqual([]);
    expect(pathExists(join(project, ".agents", "skills", "foo"))).toBe(false);
    expect(pathExists(join(project, ".claude", "skills", "foo"))).toBe(false);
  });

  test("failed state persistence compensates only paths created by the link", () => {
    const f = fixture();
    const project = join(f.root, "project");
    const keepAgents = join(project, ".agents", "skills", "keep", "keep.txt");
    const keepClaude = join(project, ".claude", "skills", "keep", "keep.txt");
    mkdirSync(join(project, ".agents", "skills", "keep"), { recursive: true });
    mkdirSync(join(project, ".claude", "skills", "keep"), { recursive: true });
    writeFileSync(keepAgents, "keep\n");
    writeFileSync(keepClaude, "keep\n");
    const before = readFileSync(f.statePath);
    chmodSync(join(f.host, ".local"), 0o500);

    const message = failureMessage(run(f, linkProjectSkill({ skill: "foo", project, mode: "symlink", gitExclude: false })));
    chmodSync(join(f.host, ".local"), 0o700);

    expect(message).toContain("write");
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(pathExists(join(project, ".agents", "skills", "foo"))).toBe(false);
    expect(pathExists(join(project, ".claude", "skills", "foo"))).toBe(false);
    expect(readFileSync(keepAgents, "utf8")).toBe("keep\n");
    expect(readFileSync(keepClaude, "utf8")).toBe("keep\n");
  });
});
