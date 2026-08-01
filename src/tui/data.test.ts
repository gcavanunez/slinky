import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { State, version } from "../lib/manifest.ts";
import {
  discoverProjectSkills,
  isSkillAvailableHere,
  projectForCwd,
  projectPlacement,
  projectSkillDescription,
  projectSkillFiles,
  projectSkillPath,
  readProjectSkillFile,
} from "./data.ts";
import type { CatalogRow } from "./data.ts";

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
    expect(projectForCwd(state, "/workspace/repo/packages/app/src")).toBe("/workspace/repo/packages/app");
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
    writeFileSync(join(root, ".agents", "skills", "agents-only", "SKILL.md"), "---\nname: agents-only\ndescription: Project-only fixture.\n---\n\n# Fixture\n");
    writeFileSync(join(root, ".agents", "skills", "agents-only", "notes.md"), "\tnotes\n");

    const skills = discoverProjectSkills(root);
    expect(skills).toEqual([
      { name: "agents-only", agents: true, claude: false },
      { name: "claude-only", agents: false, claude: true },
      { name: "shared", agents: true, claude: true },
    ]);

    const agentsOnly = skills[0];
    if (!agentsOnly) throw new Error("expected agents-only fixture");
    expect(projectSkillPath(root, agentsOnly)).toBe(join(root, ".agents", "skills", "agents-only"));
    expect(projectSkillFiles(root, agentsOnly)).toEqual(["SKILL.md", "notes.md"]);
    expect(readProjectSkillFile(root, agentsOnly, "notes.md")).toBe("\tnotes\n");
    expect(projectSkillDescription(root, agentsOnly)).toBe("Project-only fixture.");
  });
});

describe("projectPlacement", () => {
  const row = {
    name: "foo",
    projectSkill: { name: "foo", agents: true, claude: false },
    projectLink: state.projectLinks[0] ?? null,
  } satisfies Pick<CatalogRow, "name" | "projectLink" | "projectSkill">;

  test("distinguishes hidden and tracked project symlinks", () => {
    expect(projectPlacement(row)).toBe("link-tracked");
    expect(
      projectPlacement({
        ...row,
        projectLink: row.projectLink ? { ...row.projectLink, excludedTargets: [".agents/skills/foo"] } : null,
      }),
    ).toBe("link-hidden");
  });

  test("surfaces missing and unmanaged placements", () => {
    expect(projectPlacement({ ...row, projectSkill: null })).toBe("missing");
    expect(projectPlacement({ ...row, projectLink: null })).toBe("unmanaged");
  });
});

describe("isSkillAvailableHere", () => {
  test("accepts global directories, global symlinks, and project placements", () => {
    expect(isSkillAvailableHere({ liveKind: "dir", projectSkill: null })).toBe(true);
    expect(isSkillAvailableHere({ liveKind: "symlink", projectSkill: null })).toBe(true);
    expect(isSkillAvailableHere({ liveKind: "missing", projectSkill: { name: "foo", agents: true, claude: false } })).toBe(true);
  });

  test("rejects missing, broken, and invalid global entries", () => {
    expect(isSkillAvailableHere({ liveKind: "missing", projectSkill: null })).toBe(false);
    expect(isSkillAvailableHere({ liveKind: "broken-symlink", projectSkill: null })).toBe(false);
    expect(isSkillAvailableHere({ liveKind: "file", projectSkill: null })).toBe(false);
  });
});
