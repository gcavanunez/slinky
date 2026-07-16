import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function run(root: string, body: string) {
  const source = join(import.meta.dir, "manifest.ts");
  return Bun.spawnSync(
    [process.execPath, "-e", `import * as Store from ${JSON.stringify(source)}; ${body}`],
    { env: { ...process.env, SLINKY_REPO: root } },
  );
}

describe("manifest persistence", () => {
  test("loads plain schema values and defaults only a missing state file", () => {
    const root = host();
    const result = run(
      root,
      `const manifest = Store.loadManifest(); const state = Store.loadState(manifest); console.log(Object.getPrototypeOf(manifest) === Object.prototype, Object.getPrototypeOf(state) === Object.prototype, state.disabledSkills.length);`,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("true true 0");
  });

  test("rejects excess manifest properties", () => {
    const root = host();
    writeFileSync(
      join(root, "skills.manifest.json"),
      `${JSON.stringify({ ...manifest(), generatedAt: "2026-07-13T12:00:00.000Z" })}\n`,
    );
    const result = run(
      root,
      `try { Store.loadManifest(); } catch (error) { console.log(error._tag, error.operation); process.exit(7); }`,
    );

    expect(result.exitCode).toBe(7);
    expect(result.stdout.toString().trim()).toBe("ManifestFileError decode");
  });

  test("rejects malformed state instead of resetting it", () => {
    const root = host();
    mkdirSync(join(root, ".local"));
    writeFileSync(join(root, ".local", "state.json"), "{not-json}\n");
    const result = run(
      root,
      `const manifest = Store.loadManifest(); try { Store.loadState(manifest); } catch (error) { console.log(error._tag, error.operation); process.exit(8); }`,
    );

    expect(result.exitCode).toBe(8);
    expect(result.stdout.toString().trim()).toBe("StateFileError parse");
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
    const result = run(
      root,
      `const manifest = Store.loadManifest(); try { Store.loadState(manifest); } catch (error) { console.log(error._tag, error.operation); process.exit(9); }`,
    );

    expect(result.exitCode).toBe(9);
    expect(result.stdout.toString().trim()).toBe("StateFileError decode");
  });
});
