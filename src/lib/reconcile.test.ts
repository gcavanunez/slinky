import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";
import { Manifest, State, version, withManifestSkill } from "./manifest.ts";
import type { Observation } from "./reconcile.ts";
import { planSync } from "./reconcile.ts";
import { claudeRelTarget } from "./paths.ts";

const CLAUDE_SKILLS = "/home/user/.claude/skills";

const REPO = "/repo";
const MINE_HASH = "1".repeat(64);
const THEIRS_HASH = "2".repeat(64);
const claudeTarget = (name: string) => resolve(CLAUDE_SKILLS, claudeRelTarget(name));

function manifest(): Manifest {
  return Schema.decodeUnknownSync(Manifest)({
    version,
    skills: {
      mine: {
        origin: "local",
        path: "skills/mine",
        contentHash: MINE_HASH,
      },
      theirs: {
        origin: "vendor",
        path: "vendor/acme/theirs",
        contentHash: THEIRS_HASH,
        upstream: { kind: "unknown", note: null },
        vendoredAt: null,
      },
    },
    profiles: {},
  });
}

function state(enabled: Record<string, boolean>): State {
  return Schema.decodeUnknownSync(State)({
    version,
    disabledSkills: Object.entries(enabled)
      .filter(([, value]) => !value)
      .map(([name]) => name),
    activeProfile: null,
    projectLinks: [],
    recentProjects: [],
  });
}

const empty: Observation = { agents: {}, claude: {} };

describe("planSync", () => {
  test("enabled skills get created from scratch", () => {
    const plan = planSync(manifest(), state({ mine: true, theirs: true }), empty, { repo: REPO, claudeSkills: CLAUDE_SKILLS });
    expect(plan.warnings).toEqual([]);
    expect(plan.actions).toEqual([
      { type: "ensure-agents-symlink", skill: "mine", target: `${REPO}/skills/mine` },
      { type: "restore-agents-dir", skill: "theirs", from: `${REPO}/vendor/acme/theirs` },
      { type: "ensure-claude-symlink", skill: "mine" },
      { type: "ensure-claude-symlink", skill: "theirs" },
    ]);
  });

  test("steady state produces no actions", () => {
    const obs: Observation = {
      agents: {
        mine: { kind: "symlink", resolved: `${REPO}/skills/mine` },
        theirs: { kind: "dir" },
      },
      claude: {
        mine: { kind: "symlink", resolved: claudeTarget("mine") },
        theirs: { kind: "symlink", resolved: claudeTarget("theirs") },
      },
    };
    const plan = planSync(manifest(), state({ mine: true, theirs: true }), obs, { repo: REPO, claudeSkills: CLAUDE_SKILLS });
    expect(plan.actions).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  test("disabling removes links; dir removal requires hash verification", () => {
    const obs: Observation = {
      agents: {
        mine: { kind: "symlink", resolved: `${REPO}/skills/mine` },
        theirs: { kind: "dir" },
      },
      claude: {
        mine: { kind: "symlink", resolved: `${REPO}/skills/mine` },
        theirs: { kind: "symlink", resolved: "/home/x/.agents/skills/theirs" },
      },
    };
    const plan = planSync(manifest(), state({ mine: false, theirs: false }), obs, { repo: REPO, claudeSkills: CLAUDE_SKILLS });
    expect(plan.actions).toEqual([
      { type: "remove-claude", skill: "mine" },
      { type: "remove-claude", skill: "theirs" },
      { type: "remove-agents", skill: "mine" },
      { type: "remove-agents", skill: "theirs", verifyHash: THEIRS_HASH },
    ]);
  });

  test("wrong symlink target is corrected", () => {
    const obs: Observation = {
      agents: { mine: { kind: "symlink", resolved: "/elsewhere/mine" } },
      claude: { mine: { kind: "symlink", resolved: claudeTarget("mine") } },
    };
    const plan = planSync(manifest(), state({ mine: true, theirs: false }), obs, { repo: REPO, claudeSkills: CLAUDE_SKILLS });
    expect(plan.actions).toContainEqual({
      type: "ensure-agents-symlink",
      skill: "mine",
      target: `${REPO}/skills/mine`,
    });
  });

  test("real dir where local symlink expected warns without force", () => {
    const obs: Observation = {
      agents: { mine: { kind: "dir" } },
      claude: { mine: { kind: "symlink", resolved: claudeTarget("mine") } },
    };
    const plan = planSync(manifest(), state({ mine: true, theirs: false }), obs, { repo: REPO, claudeSkills: CLAUDE_SKILLS });
    expect(plan.actions.filter((a) => a.skill === "mine")).toEqual([]);
    expect(plan.warnings.some((w) => w.startsWith("mine:"))).toBe(true);

    const forced = planSync(manifest(), state({ mine: true, theirs: false }), obs, {
      repo: REPO,
      claudeSkills: CLAUDE_SKILLS,
      force: true,
    });
    expect(forced.actions).toContainEqual({
      type: "remove-agents",
      skill: "mine",
      verifyHash: MINE_HASH,
    });
    expect(forced.actions).toContainEqual({
      type: "ensure-agents-symlink",
      skill: "mine",
      target: `${REPO}/skills/mine`,
    });
  });

  test("vendor skill installed as symlink is normalized to a real dir", () => {
    const obs: Observation = {
      agents: { theirs: { kind: "symlink", resolved: `${REPO}/vendor/acme/theirs` } },
      claude: { theirs: { kind: "symlink", resolved: claudeTarget("theirs") } },
    };
    const plan = planSync(manifest(), state({ mine: false, theirs: true }), obs, { repo: REPO, claudeSkills: CLAUDE_SKILLS });
    expect(plan.actions).toContainEqual({ type: "remove-agents", skill: "theirs" });
    expect(plan.actions).toContainEqual({
      type: "restore-agents-dir",
      skill: "theirs",
      from: `${REPO}/vendor/acme/theirs`,
    });
  });

  test("foreign entries produce warnings only", () => {
    const obs: Observation = { agents: { stranger: { kind: "dir" } }, claude: {} };
    const plan = planSync(manifest(), state({ mine: false, theirs: false }), obs, { repo: REPO, claudeSkills: CLAUDE_SKILLS });
    expect(plan.actions.filter((a) => a.skill === "stranger")).toEqual([]);
    expect(plan.warnings.some((w) => w.startsWith("stranger:"))).toBe(true);
  });

  test("broken claude symlink is repaired", () => {
    const obs: Observation = {
      agents: { mine: { kind: "symlink", resolved: `${REPO}/skills/mine` } },
      claude: { mine: { kind: "broken-symlink" } },
    };
    const plan = planSync(manifest(), state({ mine: true, theirs: false }), obs, { repo: REPO, claudeSkills: CLAUDE_SKILLS });
    expect(plan.actions).toContainEqual({ type: "ensure-claude-symlink", skill: "mine" });
  });

  test("claude symlink pointing elsewhere is repaired", () => {
    const obs: Observation = {
      agents: { mine: { kind: "symlink", resolved: `${REPO}/skills/mine` } },
      claude: { mine: { kind: "symlink", resolved: "/elsewhere/mine" } },
    };
    const plan = planSync(manifest(), state({ mine: true, theirs: false }), obs, { repo: REPO, claudeSkills: CLAUDE_SKILLS });
    expect(plan.actions).toContainEqual({ type: "ensure-claude-symlink", skill: "mine" });
  });

  test("disabling does not remove an unowned real claude directory without force", () => {
    const obs: Observation = { agents: {}, claude: { mine: { kind: "dir" } } };
    const plan = planSync(manifest(), state({ mine: false, theirs: false }), obs, { repo: REPO, claudeSkills: CLAUDE_SKILLS });
    expect(plan.actions).not.toContainEqual({ type: "remove-claude", skill: "mine" });
    expect(plan.warnings.some((warning) => warning.includes("not removing without --force"))).toBe(true);

    const forced = planSync(manifest(), state({ mine: false, theirs: false }), obs, {
      repo: REPO,
      claudeSkills: CLAUDE_SKILLS,
      force: true,
    });
    expect(forced.actions).toContainEqual({ type: "remove-claude", skill: "mine" });
  });

  test("prototype-like skill names observe as missing", () => {
    const withConstructor = withManifestSkill(manifest(), "constructor", {
      origin: "local",
      path: "skills/constructor",
      contentHash: "3".repeat(64),
    });
    const plan = planSync(withConstructor, state({ mine: false, theirs: false, constructor: true }), { agents: {}, claude: {} }, { repo: REPO, claudeSkills: CLAUDE_SKILLS });
    expect(plan.actions).toContainEqual({
      type: "ensure-agents-symlink",
      skill: "constructor",
      target: `${REPO}/skills/constructor`,
    });
  });
});
