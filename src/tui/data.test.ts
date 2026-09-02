import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { contentHash } from "../lib/hash.ts";
import { State, stateVersion } from "../lib/manifest.ts";
import {
  diffSkill,
  discoverProjectSkills,
  isSkillAvailableHere,
  projectForCwd,
  projectPlacement,
  projectSkillDescription,
  projectSkillFiles,
  projectSkillPath,
  projectSkillsFor,
  readProjectSkillFile,
  verifyRow,
} from "./data.ts";
import type { CatalogRow } from "./data.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const state = Schema.decodeUnknownSync(State)({
  version: stateVersion,
  selection: { kind: "custom", disabledSkills: [] },
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

describe("projectSkillsFor", () => {
  test("reports nothing at the home directory that owns the global store", () => {
    const home = mkdtempSync(join(tmpdir(), "slinky-home-"));
    roots.push(home);
    const agentsSkills = join(home, ".agents", "skills");
    mkdirSync(join(agentsSkills, "installed"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills", "installed"), { recursive: true });

    // Without the guard every globally installed skill reads back as an unmanaged project skill.
    expect(discoverProjectSkills(home)).toEqual([{ name: "installed", agents: true, claude: true }]);
    expect(projectSkillsFor(home, agentsSkills)).toEqual([]);
  });

  test("still reports skills for an ordinary project under that home", () => {
    const home = mkdtempSync(join(tmpdir(), "slinky-home-"));
    roots.push(home);
    const agentsSkills = join(home, ".agents", "skills");
    mkdirSync(agentsSkills, { recursive: true });
    const project = join(home, "work", "app");
    mkdirSync(join(project, ".agents", "skills", "linked"), { recursive: true });

    expect(projectSkillsFor(project, agentsSkills)).toEqual([{ name: "linked", agents: true, claude: false }]);
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
    expect(isSkillAvailableHere({ placement: "dir", projectSkill: null })).toBe(true);
    expect(isSkillAvailableHere({ placement: "expected-symlink", projectSkill: null })).toBe(true);
    expect(isSkillAvailableHere({ placement: "missing", projectSkill: { name: "foo", agents: true, claude: false } })).toBe(true);
  });

  test("rejects missing, broken, wrong-target, and invalid global entries", () => {
    expect(isSkillAvailableHere({ placement: "missing", projectSkill: null })).toBe(false);
    expect(isSkillAvailableHere({ placement: "broken-symlink", projectSkill: null })).toBe(false);
    expect(isSkillAvailableHere({ placement: "wrong-symlink", projectSkill: null })).toBe(false);
    expect(isSkillAvailableHere({ placement: "file", projectSkill: null })).toBe(false);
  });
});

describe("verifyRow", () => {
  test("incrementally resolves a pending vendor hash to ok or drift", () => {
    const root = mkdtempSync(join(tmpdir(), "slinky-verify-row-"));
    roots.push(root);
    const agentsSkills = join(root, ".agents", "skills");
    const live = join(agentsSkills, "vendor-skill");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "SKILL.md"), "# vendor\n");

    const row: CatalogRow = {
      name: "vendor-skill",
      origin: "vendor",
      enabled: true,
      liveEntry: { kind: "dir" },
      placement: "dir",
      live: "checking",
      claude: false,
      projectLink: null,
      projectSkill: null,
      meta: {
        origin: "vendor",
        path: "vendor/acme/vendor-skill",
        contentHash: contentHash(live),
        upstream: { kind: "unknown", note: null },
        vendoredAt: null,
      },
    };

    expect(verifyRow({ agentsSkills, repo: root }, row).live).toBe("ok");
    writeFileSync(join(live, "SKILL.md"), "# changed\n");
    expect(verifyRow({ agentsSkills, repo: root }, row).live).toBe("drift");

    const external = join(root, "external");
    mkdirSync(external);
    writeFileSync(join(external, "SKILL.md"), "# external\n");
    rmSync(live, { recursive: true });
    symlinkSync(external, live);
    expect(verifyRow({ agentsSkills, repo: root }, row)).toMatchObject({ placement: "wrong-symlink", live: "unowned" });
  });

  test("does not traverse an unowned vendor symlink for diff", () => {
    const root = mkdtempSync(join(tmpdir(), "slinky-diff-row-"));
    roots.push(root);
    const agentsSkills = join(root, ".agents", "skills");
    const external = join(root, "external");
    mkdirSync(agentsSkills, { recursive: true });
    mkdirSync(external);
    symlinkSync(external, join(agentsSkills, "vendor-skill"));
    const row = {
      name: "vendor-skill",
      origin: "vendor",
      enabled: true,
      liveEntry: { kind: "symlink", resolved: "/unowned" },
      placement: "wrong-symlink",
      live: "missing",
      claude: false,
      projectLink: null,
      projectSkill: null,
      meta: {
        origin: "vendor",
        path: "vendor/acme/vendor-skill",
        contentHash: "a".repeat(64),
        upstream: { kind: "unknown", note: null },
        vendoredAt: null,
      },
    } satisfies CatalogRow;

    expect(diffSkill({ agentsSkills, repo: root }, row)).toEqual({ kind: "unowned" });
  });
});
