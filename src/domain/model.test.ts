import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import {
  Manifest,
  State,
  getSkill,
  validateState,
  withProfile,
  withSkillEnabled,
} from "./model.ts";

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
    expect(vendor?.origin === "vendor" ? vendor.vendoredAt : null).toBe(
      "2026-07-13T12:00:00.000Z",
    );
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

  test("rejects profile drift and prototype-like phantom references", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)(manifestInput(), strict);
    const drifted = Schema.decodeUnknownSync(State)(
      { ...stateInput(), activeProfile: "work", disabledSkills: [] },
      strict,
    );
    const phantom = Schema.decodeUnknownSync(State)(
      { ...stateInput(), disabledSkills: ["constructor"] },
      strict,
    );

    expect(validateState(manifest, drifted)).not.toEqual([]);
    expect(validateState(manifest, phantom)).not.toEqual([]);
    expect(getSkill(manifest, "constructor")).toBeUndefined();
  });
});
