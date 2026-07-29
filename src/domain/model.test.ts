import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Manifest, ProjectLink, State, getSkill, validateState, withManifestSkill, withProfile, withProjectLink, withSkillEnabled, withoutProjectLink } from "./model.ts";

const strict = { errors: "all", onExcessProperty: "error" } as const;
const HASH = "a".repeat(64);

const manifestInput = () => ({
  version: 1,
  skills: {
    foo: { origin: "local", path: "skills/foo", contentHash: HASH },
    bar: {
      origin: "vendor",
      path: "vendor/acme/bar",
      contentHash: HASH,
      upstream: {
        kind: "github",
        repository: "acme/skills",
        url: "https://github.com/acme/skills",
        tracking: { kind: "tree", path: "skills/bar/SKILL.md", hash: "b".repeat(40) },
      },
      vendoredAt: "2026-07-13T12:00:00.000Z",
    },
  },
  profiles: { work: ["foo"] },
});

const stateInput = () => ({
  version: 1,
  disabledSkills: ["bar"],
  activeProfile: null,
  projectLinks: [],
  recentProjects: [],
});

describe("domain schemas", () => {
  test("decodes owned documents into plain schema values and encodes canonical timestamps", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)(manifestInput(), strict);
    const state = Schema.decodeUnknownSync(State)(stateInput(), strict);

    expect(Object.getPrototypeOf(manifest)).toBe(Object.prototype);
    expect(getSkill(manifest, "foo")?.origin).toBe("local");
    expect(Object.getPrototypeOf(state)).toBe(Object.prototype);

    const encoded = Schema.encodeSync(Manifest)(manifest, strict);
    const vendor = Object.values(encoded.skills).find((skill) => skill.origin === "vendor");
    expect(vendor?.origin === "vendor" ? vendor.vendoredAt : null).toBe("2026-07-13T12:00:00.000Z");
  });

  test("rejects the superseded manifest shape", () => {
    const input = {
      ...manifestInput(),
      generatedAt: "2026-07-13T12:00:00.000Z",
      skills: {
        foo: {
          origin: "vendor",
          path: "vendor/acme/foo",
          contentHash: HASH,
          source: "acme/skills",
          sourceType: "github",
        },
      },
    };

    expect(() => Schema.decodeUnknownSync(Manifest)(input, strict)).toThrow();
  });

  test("rejects unsafe names, paths, hashes, and unknown profile members", () => {
    const named = manifestInput();
    const unsafeName = { ...named, skills: { "../escape": named.skills.foo } };

    const unsafePath = manifestInput();
    unsafePath.skills.foo.path = "skills/../foo";

    const badHash = manifestInput();
    badHash.skills.foo.contentHash = "not-a-hash";

    const badProfile = manifestInput();
    badProfile.profiles.work = ["missing"];

    expect(() => Schema.decodeUnknownSync(Manifest)(unsafeName, strict)).toThrow();
    expect(() => Schema.decodeUnknownSync(Manifest)(unsafePath, strict)).toThrow();
    expect(() => Schema.decodeUnknownSync(Manifest)(badHash, strict)).toThrow();
    expect(() => Schema.decodeUnknownSync(Manifest)(badProfile, strict)).toThrow();
  });

  test("allows names outside the old alphanumeric naming policy", () => {
    const input = {
      version: 1,
      skills: {
        "@scope+skill": {
          origin: "local",
          path: "skills/@scope+skill",
          contentHash: HASH,
        },
      },
      profiles: { "Focused work": ["@scope+skill"] },
    };

    expect(() => Schema.decodeUnknownSync(Manifest)(input, strict)).not.toThrow();
  });

  test("rejects old enabled state and impossible project-link variants", () => {
    const oldState = { ...stateInput(), enabled: { foo: true } };
    expect(() => Schema.decodeUnknownSync(State)(oldState, strict)).toThrow();

    const copyWithoutSnapshot = stateInput();
    copyWithoutSnapshot.projectLinks = [
      {
        mode: "copy",
        project: "/tmp/project",
        skill: "foo",
        targets: [".agents/skills/foo"],
        excludedTargets: [],
        linkedAt: "2026-07-13T12:00:00.000Z",
      } as never,
    ];

    const symlinkWithSnapshot = stateInput();
    symlinkWithSnapshot.projectLinks = [
      {
        mode: "symlink",
        project: "/tmp/project",
        skill: "foo",
        targets: [".agents/skills/foo"],
        excludedTargets: [],
        linkedAt: "2026-07-13T12:00:00.000Z",
        snapshotHash: HASH,
      } as never,
    ];

    const destructiveTarget = stateInput();
    destructiveTarget.projectLinks = [
      {
        mode: "copy",
        project: "/tmp/project",
        skill: "foo",
        targets: ["src"],
        excludedTargets: [],
        linkedAt: "2026-07-13T12:00:00.000Z",
        snapshotHash: HASH,
      } as never,
    ];

    expect(() => Schema.decodeUnknownSync(State)(copyWithoutSnapshot, strict)).toThrow();
    expect(() => Schema.decodeUnknownSync(State)(symlinkWithSnapshot, strict)).toThrow();
    expect(() => Schema.decodeUnknownSync(State)(destructiveTarget, strict)).toThrow();
  });

  test("state updates return new values and preserve their inputs", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)(manifestInput(), strict);
    const initial = Schema.decodeUnknownSync(State)(stateInput(), strict);

    const enabled = withSkillEnabled(initial, "bar", true);
    expect(initial.disabledSkills).toEqual(["bar"]);
    expect(enabled.disabledSkills).toEqual([]);

    const profiled = withProfile(manifest, enabled, "work");
    expect(profiled.activeProfile).toBe("work");
    expect(profiled.disabledSkills).toEqual(["bar"]);
    expect(enabled.activeProfile).toBeNull();
  });

  test("transitions validate state that already contains decoded project timestamps", () => {
    const initial = Schema.decodeUnknownSync(State)({
      ...stateInput(),
      projectLinks: [
        {
          mode: "symlink",
          project: "/tmp/project-one",
          skill: "foo",
          targets: [".agents/skills/foo"],
          excludedTargets: [],
          linkedAt: "2026-07-13T12:00:00.000Z",
        },
      ],
    });
    const first = initial.projectLinks[0];
    if (!first) throw new Error("expected first project link");
    const second = Schema.decodeUnknownSync(ProjectLink)({
      mode: "symlink",
      project: "/tmp/project-two",
      skill: "bar",
      targets: [".agents/skills/bar"],
      excludedTargets: [],
      linkedAt: "2026-07-14T12:00:00.000Z",
    });

    const added = withProjectLink(initial, second);
    const addedFirst = added.projectLinks[0];
    if (!addedFirst) throw new Error("expected added first project link");
    const enabled = withSkillEnabled(added, "bar", true);
    const removed = withoutProjectLink(added, addedFirst);

    expect(typeof first.linkedAt).not.toBe("string");
    expect(added.projectLinks).toEqual([first, second]);
    expect(enabled.disabledSkills).toEqual([]);
    expect(removed.projectLinks).toEqual([second]);
    expect(initial.projectLinks).toEqual([first]);
  });

  test("manifest transitions validate decoded vendor timestamps", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)(manifestInput(), strict);
    const updated = withManifestSkill(manifest, "foo", {
      origin: "local",
      path: "skills/foo",
      contentHash: "c".repeat(64),
    });
    const vendor = getSkill(updated, "bar");

    expect(vendor?.origin).toBe("vendor");
    expect(vendor?.origin === "vendor" ? typeof vendor.vendoredAt : "missing").not.toBe("string");
    expect(getSkill(updated, "foo")?.contentHash).toBe("c".repeat(64));
    expect(getSkill(manifest, "foo")?.contentHash).toBe(HASH);
  });

  test("rejects profile drift and prototype-like phantom references", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)(manifestInput(), strict);
    const drifted = Schema.decodeUnknownSync(State)({ ...stateInput(), activeProfile: "work", disabledSkills: [] }, strict);
    const phantom = Schema.decodeUnknownSync(State)({ ...stateInput(), disabledSkills: ["constructor"] }, strict);

    expect(validateState(manifest, drifted)).not.toEqual([]);
    expect(validateState(manifest, phantom)).not.toEqual([]);
    expect(getSkill(manifest, "constructor")).toBeUndefined();
  });
});
