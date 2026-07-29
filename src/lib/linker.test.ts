import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Schema from "effect/Schema";
import { Manifest, ProjectLink, State, version } from "./manifest.ts";
import { applyUnlink, checkLink, linkSkill, prepareUnlink, unlinkSkill } from "./linker.ts";
import { REPO } from "./paths.ts";

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

    const result = linkSkill(manifest, state, {
      skill: "foo",
      project,
      mode: "symlink",
      gitExclude: false,
      claude: false,
    });
    const encoded = Schema.encodeSync(ProjectLink)(result.link);

    expect(result.state.projectLinks).toEqual([result.link]);
    expect(encoded.linkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(linkExists(join(project, ".agents", "skills", "foo"))).toBe(true);
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

    expect(checkLink(manifest, link)).toBe("drifted-local");
    expect(() => unlinkSkill(manifest, state, "foo", project)).toThrow("replaced or retargeted");
    expect(existsSync(join(target, "user-file.txt"))).toBe(true);
  });

  test("prepares state before deleting a validated link", () => {
    const project = mkdtempSync(join(tmpdir(), "slinky-link-"));
    roots.push(project);
    const target = join(project, ".agents", "skills", "foo");
    mkdirSync(join(project, ".agents", "skills"), { recursive: true });
    symlinkSync(resolve(REPO, "skills", "foo"), target);

    const { manifest, state } = fixtures(project);

    const prepared = prepareUnlink(manifest, state, "foo", project);
    expect(linkExists(target)).toBe(true);
    expect(prepared.state.projectLinks).toEqual([]);

    applyUnlink(prepared.link);
    expect(linkExists(target)).toBe(false);
  });
});
