import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const version = 1;

interface Fixture {
  readonly root: string;
  readonly host: string;
  readonly home: string;
  readonly statePath: string;
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

function run(f: Fixture, body: string) {
  const source = join(import.meta.dir, "catalogActions.ts");
  return Bun.spawnSync([process.execPath, "-e", `import * as Actions from ${JSON.stringify(source)}; ${body}`], { env: { ...process.env, HOME: f.home, SLINKY_REPO: f.host } });
}

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

    const result = run(f, `console.log(JSON.stringify(Actions.setSkillsEnabled(["foo", "bar"], false)));`);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
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

    const result = run(f, `console.log(JSON.stringify(Actions.setSkillsEnabled(["foo", "bar"], true)));`);

    expect(result.exitCode).toBe(0);
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

    const result = run(f, `try { Actions.setSkillsEnabled(["foo", "missing"], false); } catch (error) { console.error(error.message); process.exit(7); }`);

    expect(result.exitCode).toBe(7);
    expect(result.stderr.toString()).toContain("unknown skill: missing");
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(pathExists(join(f.home, ".agents", "skills", "foo"))).toBe(true);
    expect(pathExists(join(f.home, ".claude", "skills", "foo"))).toBe(true);
  });

  test("profile application persists its exact disabled complement", () => {
    const f = fixture();
    for (const name of ["foo", "bar", "baz"]) installGlobal(f, name);

    const result = run(f, `Actions.applyProfile("focus");`);

    expect(result.exitCode).toBe(0);
    expect(state(f).disabledSkills).toEqual(["bar"]);
    expect(state(f).activeProfile).toBe("focus");
    expect(pathExists(join(f.home, ".agents", "skills", "foo"))).toBe(true);
    expect(pathExists(join(f.home, ".agents", "skills", "bar"))).toBe(false);
    expect(pathExists(join(f.home, ".agents", "skills", "baz"))).toBe(true);
  });

  test("dry-run mutations return prospective actions without changing state or stores", () => {
    const f = fixture(["foo"]);
    const before = readFileSync(f.statePath);

    const result = run(
      f,
      `console.log(JSON.stringify([
        Actions.setSkillsEnabled(["foo"], true, { dryRun: true }),
        Actions.setSkillsEnabled(["bar"], false, { dryRun: true }),
        Actions.applyProfile("focus", { dryRun: true }),
      ]));`,
    );

    expect(result.exitCode).toBe(0);
    const previews = JSON.parse(result.stdout.toString()) as Array<{
      messages: string[];
      warnings: string[];
      dryRun: boolean;
    }>;
    expect(previews).toHaveLength(3);
    for (const preview of previews) {
      expect(preview.dryRun).toBe(true);
      expect(preview.messages.length).toBeGreaterThan(0);
    }
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(existsSync(join(f.home, ".agents"))).toBe(false);
    expect(existsSync(join(f.home, ".claude"))).toBe(false);
  });

  test("successful link persists one project link and creates every target", () => {
    const f = fixture();
    const project = join(f.root, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });

    const result = run(f, `console.log(JSON.stringify(Actions.linkProjectSkill({ skill: "foo", project: ${JSON.stringify(project)}, mode: "symlink", gitExclude: false })));`);

    expect(result.exitCode).toBe(0);
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
    expect(run(f, `Actions.linkProjectSkill({ skill: "foo", project: ${JSON.stringify(project)}, mode: "symlink", gitExclude: false });`).exitCode).toBe(0);

    const result = run(f, `console.log(JSON.stringify(Actions.unlinkProjectSkill("foo", ${JSON.stringify(project)})));`);

    expect(result.exitCode).toBe(0);
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

    const result = run(
      f,
      `try { Actions.linkProjectSkill({ skill: "foo", project: ${JSON.stringify(project)}, mode: "symlink", gitExclude: false }); } catch (error) { console.error(error.message); process.exit(9); }`,
    );
    chmodSync(join(f.host, ".local"), 0o700);

    expect(result.exitCode).toBe(9);
    expect(result.stderr.toString()).toContain("write");
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(pathExists(join(project, ".agents", "skills", "foo"))).toBe(false);
    expect(pathExists(join(project, ".claude", "skills", "foo"))).toBe(false);
    expect(readFileSync(keepAgents, "utf8")).toBe("keep\n");
    expect(readFileSync(keepClaude, "utf8")).toBe("keep\n");
  });
});
