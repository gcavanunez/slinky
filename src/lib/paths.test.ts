import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Layer } from "effect";
import { Paths, RepoResolution } from "./paths.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Resolve Paths with a deterministic environment instead of process.env. */
function resolutionFor(env: Record<string, string>): RepoResolution {
  const layer = Paths.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));
  return Effect.runSync(
    Effect.gen(function* () {
      return (yield* Paths).resolution;
    }).pipe(Effect.provide(layer)),
  );
}

function skillLockFor(env: Record<string, string>): string {
  const layer = Paths.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));
  return Effect.runSync(
    Effect.gen(function* () {
      return (yield* Paths).skillLock;
    }).pipe(Effect.provide(layer)),
  );
}

describe("skills host discovery", () => {
  test("uses SLINKY_REPO when the application lives outside the host", () => {
    const root = mkdtempSync(join(tmpdir(), "slinky-paths-"));
    roots.push(root);
    const host = join(root, "skills-host");
    mkdirSync(host);
    writeFileSync(join(host, "skills.manifest.json"), "{}\n");

    const resolution = resolutionFor({ HOME: join(root, "home"), SLINKY_REPO: host });

    expect(RepoResolution.$is("Found")(resolution)).toBe(true);
    if (RepoResolution.$is("Found")(resolution)) expect(resolution.repo).toBe(host);
  });

  test("reports an obsolete config shape instead of silently ignoring it", () => {
    const root = mkdtempSync(join(tmpdir(), "slinky-config-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "slinky"), { recursive: true });
    writeFileSync(join(home, ".config", "slinky", "config.json"), `${JSON.stringify({ repo: "/old/shape" })}\n`);

    const resolution = resolutionFor({ HOME: home, SLINKY_REPO: "" });

    expect(RepoResolution.$is("Invalid")(resolution)).toBe(true);
    if (RepoResolution.$is("Invalid")(resolution)) {
      expect(resolution.error._tag).toBe("ConfigFileError");
      expect(resolution.error.operation).toBe("decode");
    }
  });

  test("does not fall through when SLINKY_REPO is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "slinky-env-"));
    roots.push(root);
    const missing = join(root, "missing-host");

    const resolution = resolutionFor({ HOME: join(root, "home"), SLINKY_REPO: missing });

    expect(RepoResolution.$is("Invalid")(resolution)).toBe(true);
    if (RepoResolution.$is("Invalid")(resolution)) expect(resolution.error._tag).toBe("ConfigFileError");
  });
});

describe("skills.sh state", () => {
  test("uses the same XDG lock location as skills.sh", () => {
    expect(skillLockFor({ HOME: "/home/test", XDG_STATE_HOME: "/state" })).toBe("/state/skills/.skill-lock.json");
    expect(skillLockFor({ HOME: "/home/test" })).toBe("/home/test/.agents/.skill-lock.json");
  });
});
