import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { getDisabledSkills, isSkillEnabled, stateVersion } from "../domain/model.ts";
import { ManifestStore } from "./manifest.ts";
import type { ManifestStoreInterface } from "./manifest.ts";
import { HostRepo, hostRepoPaths } from "./paths.ts";

const roots: string[] = [];
const HASH = "a".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const manifest = () => ({
  version: 1,
  skills: {
    foo: { origin: "local", path: "skills/foo", contentHash: HASH },
    bar: { origin: "local", path: "skills/bar", contentHash: "b".repeat(64) },
  },
  profiles: { focus: ["foo"] },
});

function host(): string {
  const root = mkdtempSync(join(tmpdir(), "slinky-manifest-"));
  roots.push(root);
  writeFileSync(join(root, "skills.manifest.json"), `${JSON.stringify(manifest())}\n`);
  return root;
}

const storeLayer = (root: string) => ManifestStore.layer.pipe(Layer.provide(Layer.succeed(HostRepo, HostRepo.of(hostRepoPaths(root)))));

const run = <A, E>(root: string, body: (store: ManifestStoreInterface) => Effect.Effect<A, E>): Exit.Exit<A, E> =>
  Effect.runSyncExit(
    Effect.gen(function* () {
      const store = yield* ManifestStore;
      return yield* body(store);
    }).pipe(Effect.provide(storeLayer(root))),
  );

const FileFailure = Schema.Struct({ _tag: Schema.String, operation: Schema.String });
type FileFailure = typeof FileFailure.Type;
const isFileFailure = Schema.is(FileFailure);

const failure = <A, E>(exit: Exit.Exit<A, E>): FileFailure => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const candidate = Cause.squash(exit.cause);
  if (!isFileFailure(candidate)) throw new Error("expected a tagged file failure");
  return candidate;
};

describe("manifest persistence", () => {
  test("loads plain schema values and defaults only a missing state file", () => {
    const root = host();
    const exit = run(root, (store) =>
      Effect.gen(function* () {
        const loaded = yield* store.loadManifest();
        const state = yield* store.loadState(loaded);
        return [Object.getPrototypeOf(loaded) === Object.prototype, Object.getPrototypeOf(state) === Object.prototype, getDisabledSkills(loaded, state).length];
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual([true, true, 0]);
  });

  test("rejects excess manifest properties", () => {
    const root = host();
    writeFileSync(join(root, "skills.manifest.json"), `${JSON.stringify({ ...manifest(), generatedAt: "2026-07-13T12:00:00.000Z" })}\n`);
    const error = failure(run(root, (store) => store.loadManifest()));

    expect(error._tag).toBe("ManifestFileError");
    expect(error.operation).toBe("decode");
  });

  test("rejects malformed state instead of resetting it", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    writeFileSync(join(root, ".local", "state.json"), "{not-json}\n");
    const error = failure(run(root, (store) => store.loadManifest().pipe(Effect.flatMap((loaded) => store.loadState(loaded)))));

    expect(error._tag).toBe("StateFileError");
    expect(error.operation).toBe("parse");
  });

  test("migrates v1 custom state and drops disabled tombstones", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    writeFileSync(
      join(root, ".local", "state.json"),
      `${JSON.stringify({
        version: 1,
        disabledSkills: ["missing"],
        activeProfile: null,
        projectLinks: [],
        recentProjects: [],
      })}\n`,
    );
    const exit = run(root, (store) => store.loadManifest().pipe(Effect.flatMap((loaded) => store.loadState(loaded))));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.version).toBe(stateVersion);
      expect(exit.value.selection).toEqual({ kind: "custom", disabledSkills: [] });
    }
  });

  test("migrates an existing v1 active profile by identity, ignoring its cached complement", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    writeFileSync(
      join(root, ".local", "state.json"),
      `${JSON.stringify({ version: 1, disabledSkills: ["foo", "missing"], activeProfile: "focus", projectLinks: [], recentProjects: [] })}\n`,
    );

    const exit = run(root, (store) => store.loadManifest().pipe(Effect.flatMap((loaded) => store.loadState(loaded))));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.selection).toEqual({ kind: "profile", name: "focus" });
  });

  test("migrates a retired v1 profile to its filtered custom disabled skills", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    writeFileSync(
      join(root, ".local", "state.json"),
      `${JSON.stringify({ version: 1, disabledSkills: ["bar", "missing"], activeProfile: "retired", projectLinks: [], recentProjects: [] })}\n`,
    );

    const exit = run(root, (store) => store.loadManifest().pipe(Effect.flatMap((loaded) => store.loadState(loaded))));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.selection).toEqual({ kind: "custom", disabledSkills: ["bar"] });
  });

  test("migrates v1 selection against the resulting manifest while retaining old project links for retirement checks", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    writeFileSync(
      join(root, ".local", "state.json"),
      `${JSON.stringify({
        version: 1,
        disabledSkills: ["bar"],
        activeProfile: "focus",
        projectLinks: [
          {
            mode: "symlink",
            project: "/tmp/project",
            skill: "foo",
            targets: [".agents/skills/foo"],
            excludedTargets: [],
            linkedAt: "2026-07-13T12:00:00.000Z",
          },
        ],
        recentProjects: [],
      })}\n`,
    );

    const exit = run(root, (store) =>
      Effect.gen(function* () {
        const previous = yield* store.loadManifest();
        const current = { ...previous, skills: { bar: previous.skills.bar! }, profiles: {} };
        return yield* store.loadStateForTransition(current, previous);
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.selection).toEqual({ kind: "custom", disabledSkills: ["bar"] });
      expect(exit.value.projectLinks.map((link) => link.skill)).toEqual(["foo"]);
    }
  });

  test("derives disabled intent from a retired v2 profile during a manifest transition", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    writeFileSync(
      join(root, ".local", "state.json"),
      `${JSON.stringify({ version: stateVersion, selection: { kind: "profile", name: "focus" }, projectLinks: [], recentProjects: [] })}\n`,
    );

    const exit = run(root, (store) =>
      Effect.gen(function* () {
        const previous = yield* store.loadManifest();
        const resulting = { ...previous, profiles: {} };
        return yield* store.loadStateForTransition(resulting, previous);
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.selection).toEqual({ kind: "custom", disabledSkills: ["bar"] });
  });

  test("normalizes a retired v2 profile to the documented all-enabled custom fallback", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    writeFileSync(
      join(root, ".local", "state.json"),
      `${JSON.stringify({ version: stateVersion, selection: { kind: "profile", name: "retired" }, projectLinks: [], recentProjects: [] })}\n`,
    );

    const exit = run(root, (store) => store.loadManifest().pipe(Effect.flatMap((loaded) => store.loadState(loaded))));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.selection).toEqual({ kind: "custom", disabledSkills: [] });
  });

  test("round-trips only canonical v2 state", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    writeFileSync(join(root, ".local", "state.json"), `${JSON.stringify({ version: 1, disabledSkills: ["foo"], activeProfile: null, projectLinks: [], recentProjects: [] })}\n`);

    const exit = run(root, (store) =>
      Effect.gen(function* () {
        const loadedManifest = yield* store.loadManifest();
        const migrated = yield* store.loadState(loadedManifest);
        yield* store.saveState(migrated);
        return yield* store.loadState(loadedManifest);
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.selection).toEqual({ kind: "custom", disabledSkills: ["foo"] });
    expect(JSON.parse(readFileSync(join(root, ".local", "state.json"), "utf8"))).toEqual({
      version: stateVersion,
      selection: { kind: "custom", disabledSkills: ["foo"] },
      projectLinks: [],
      recentProjects: [],
    });
  });

  test("profile membership changes take effect without rewriting profile state", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    const statePath = join(root, ".local", "state.json");
    writeFileSync(statePath, `${JSON.stringify({ version: stateVersion, selection: { kind: "profile", name: "focus" }, projectLinks: [], recentProjects: [] })}\n`);
    const before = readFileSync(statePath, "utf8");

    const exit = run(root, (store) =>
      Effect.gen(function* () {
        const firstManifest = yield* store.loadManifest();
        const firstState = yield* store.loadState(firstManifest);
        const changedManifest = { ...firstManifest, profiles: { focus: ["bar"] } };
        const secondState = yield* store.loadState(changedManifest);
        return [isSkillEnabled(firstManifest, firstState, "foo"), isSkillEnabled(changedManifest, secondState, "foo")];
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual([true, false]);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  test("strictly rejects excess v1 state properties", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    writeFileSync(
      join(root, ".local", "state.json"),
      `${JSON.stringify({ version: 1, disabledSkills: [], activeProfile: null, projectLinks: [], recentProjects: [], selection: null })}\n`,
    );

    const error = failure(run(root, (store) => store.loadManifest().pipe(Effect.flatMap((loaded) => store.loadState(loaded)))));
    expect(error._tag).toBe("StateFileError");
    expect(error.operation).toBe("decode");
  });

  test("still rejects project links for skills removed from the manifest", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    writeFileSync(
      join(root, ".local", "state.json"),
      `${JSON.stringify({
        version: 1,
        disabledSkills: [],
        activeProfile: null,
        projectLinks: [
          {
            mode: "symlink",
            project: "/tmp/project",
            skill: "missing",
            targets: [".agents/skills/missing"],
            excludedTargets: [],
            linkedAt: "2026-07-13T12:00:00.000Z",
          },
        ],
        recentProjects: [],
      })}\n`,
    );

    const error = failure(run(root, (store) => store.loadManifest().pipe(Effect.flatMap((loaded) => store.loadState(loaded)))));
    expect(error._tag).toBe("StateFileError");
    expect(error.operation).toBe("decode");
  });
});
