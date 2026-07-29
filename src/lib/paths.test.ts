import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("skills host discovery", () => {
  test("uses SLINKY_REPO when the application lives outside the host", () => {
    const root = mkdtempSync(join(tmpdir(), "slinky-paths-"));
    roots.push(root);
    const host = join(root, "skills-host");
    const elsewhere = join(root, "project");
    mkdirSync(host);
    mkdirSync(elsewhere);
    writeFileSync(join(host, "skills.manifest.json"), "{}\n");

    const source = join(import.meta.dir, "paths.ts");
    const result = Bun.spawnSync([process.execPath, "-e", `import { REPO } from ${JSON.stringify(source)}; console.log(REPO)`], {
      cwd: elsewhere,
      env: { ...process.env, SLINKY_REPO: host },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(host);
  });

  test("reports an obsolete config shape instead of silently ignoring it", () => {
    const root = mkdtempSync(join(tmpdir(), "slinky-config-"));
    roots.push(root);
    const home = join(root, "home");
    const elsewhere = join(root, "project");
    mkdirSync(join(home, ".config", "slinky"), { recursive: true });
    mkdirSync(elsewhere);
    writeFileSync(join(home, ".config", "slinky", "config.json"), `${JSON.stringify({ repo: "/old/shape" })}\n`);

    const source = join(import.meta.dir, "paths.ts");
    const result = Bun.spawnSync(
      [process.execPath, "-e", `import { repoResolutionError } from ${JSON.stringify(source)}; console.log(repoResolutionError?._tag, repoResolutionError?.operation);`],
      { cwd: elsewhere, env: { ...process.env, HOME: home, SLINKY_REPO: "" } },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("ConfigFileError decode");
  });

  test("does not fall through when SLINKY_REPO is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "slinky-env-"));
    roots.push(root);
    const elsewhere = join(root, "project");
    mkdirSync(elsewhere);

    const source = join(import.meta.dir, "paths.ts");
    const missing = join(root, "missing-host");
    const result = Bun.spawnSync([process.execPath, "-e", `import { REPO, repoResolutionError } from ${JSON.stringify(source)}; console.log(REPO, repoResolutionError?._tag);`], {
      cwd: elsewhere,
      env: { ...process.env, SLINKY_REPO: missing },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("ConfigFileError");
  });
});
