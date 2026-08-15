import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer } from "effect";
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
  },
  profiles: {},
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

const failure = <A, E>(exit: Exit.Exit<A, E>): { _tag?: string; operation?: string } => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  return Cause.squash(exit.cause) as { _tag?: string; operation?: string };
};

describe("manifest persistence", () => {
  test("loads plain schema values and defaults only a missing state file", () => {
    const root = host();
    const exit = run(root, (store) =>
      Effect.gen(function* () {
        const loaded = yield* store.loadManifest();
        const state = yield* store.loadState(loaded);
        return [Object.getPrototypeOf(loaded) === Object.prototype, Object.getPrototypeOf(state) === Object.prototype, state.disabledSkills.length];
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

  test("rejects state references that are not in the manifest", () => {
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
    const error = failure(run(root, (store) => store.loadManifest().pipe(Effect.flatMap((loaded) => store.loadState(loaded)))));

    expect(error._tag).toBe("StateFileError");
    expect(error.operation).toBe("decode");
  });
});
