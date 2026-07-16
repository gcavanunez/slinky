import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { State, version } from "../lib/manifest.ts";
import {
  discoverProjectSkills,
  projectForCwd,
  projectSkillDescription,
  projectSkillFiles,
  projectSkillPath,
  readProjectSkillFile,
} from "./data.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const state = Schema.decodeUnknownSync(State)({
  version,
  disabledSkills: [],
  activeProfile: null,
  projectLinks: [
    {
      mode: "symlink",
      project: "/workspace/repo",
      skill: "foo",
      targets: [".agents/skills/foo"],
      excludedTargets: [],
      linkedAt: "2026-07-15T00:00:00.000Z",
    },
    {
      mode: "copy",
      project: "/workspace/repo/packages/app",
      skill: "bar",
      targets: [".agents/skills/bar"],
      excludedTargets: [],
      linkedAt: "2026-07-15T00:00:00.000Z",
      snapshotHash: "a".repeat(64),
    },
  ],
  recentProjects: [],
});

describe("projectForCwd", () => {
  test("uses the nearest linked project ancestor", () => {
    expect(projectForCwd(state, "/workspace/repo/packages/app/src")).toBe(
      "/workspace/repo/packages/app",
    );
    expect(projectForCwd(state, "/workspace/repo/other")).toBe("/workspace/repo");
  });

  test("falls back to cwd outside recorded projects", () => {
    expect(projectForCwd(state, "/workspace/other")).toBe("/workspace/other");
  });
});

describe("discoverProjectSkills", () => {
  test("merges skills from project agent and Claude stores", () => {
    const root = mkdtempSync(join(tmpdir(), "slinky-project-skills-"));
    roots.push(root);
    mkdirSync(join(root, ".agents", "skills", "agents-only"), { recursive: true });
    mkdirSync(join(root, ".agents", "skills", "shared"), { recursive: true });
    mkdirSync(join(root, ".claude", "skills", "claude-only"), { recursive: true });
    mkdirSync(join(root, ".claude", "skills", "shared"), { recursive: true });
    writeFileSync(
      join(root, ".agents", "skills", "agents-only", "SKILL.md"),
      "---\nname: agents-only\ndescription: Project-only fixture.\n---\n\n# Fixture\n",
    );
    writeFileSync(join(root, ".agents", "skills", "agents-only", "notes.md"), "notes\n");

    const skills = discoverProjectSkills(root);
    expect(skills).toEqual([
      { name: "agents-only", agents: true, claude: false },
      { name: "claude-only", agents: false, claude: true },
      { name: "shared", agents: true, claude: true },
    ]);

    const agentsOnly = skills[0];
    if (!agentsOnly) throw new Error("expected agents-only fixture");
    expect(projectSkillPath(root, agentsOnly)).toBe(
      join(root, ".agents", "skills", "agents-only"),
    );
    expect(projectSkillFiles(root, agentsOnly)).toEqual(["SKILL.md", "notes.md"]);
    expect(readProjectSkillFile(root, agentsOnly, "notes.md")).toEqual(["notes", ""]);
    expect(projectSkillDescription(root, agentsOnly)).toBe("Project-only fixture.");
  });
});

describe("setSkillsEnabled", () => {
  test("persists and reconciles a group as one operation", () => {
    const root = mkdtempSync(join(tmpdir(), "slinky-group-toggle-"));
    roots.push(root);
    const host = join(root, "host");
    const home = join(root, "home");
    mkdirSync(join(host, ".local"), { recursive: true });
    mkdirSync(join(host, "skills", "foo"), { recursive: true });
    mkdirSync(join(host, "skills", "bar"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(host, "skills", "foo", "SKILL.md"), "# foo\n");
    writeFileSync(join(host, "skills", "bar", "SKILL.md"), "# bar\n");
    writeFileSync(
      join(host, "skills.manifest.json"),
      `${JSON.stringify({
        version,
        skills: {
          foo: { origin: "local", path: "skills/foo", contentHash: "a".repeat(64) },
          bar: { origin: "local", path: "skills/bar", contentHash: "b".repeat(64) },
        },
        profiles: {},
      })}\n`,
    );
    writeFileSync(
      join(host, ".local", "state.json"),
      `${JSON.stringify({
        version,
        disabledSkills: [],
        activeProfile: null,
        projectLinks: [],
        recentProjects: [],
      })}\n`,
    );

    const source = join(import.meta.dir, "data.ts");
    const toggle = (enabled: boolean) => Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { setSkillsEnabled } from ${JSON.stringify(source)}; setSkillsEnabled(["foo", "bar"], ${enabled});`,
      ],
      { env: { ...process.env, HOME: home, SLINKY_REPO: host } },
    );

    expect(toggle(false).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(host, ".local", "state.json"), "utf8")).disabledSkills)
      .toEqual(["bar", "foo"]);

    expect(toggle(true).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(host, ".local", "state.json"), "utf8")).disabledSkills)
      .toEqual([]);
  });
});
