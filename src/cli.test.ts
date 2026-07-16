import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI options", () => {
  test("rejects a misspelled dry-run option instead of syncing", () => {
    const host = mkdtempSync(join(tmpdir(), "slinky-cli-"));
    roots.push(host);
    writeFileSync(
      join(host, "skills.manifest.json"),
      `${JSON.stringify({ version: 1, skills: {}, profiles: {} })}\n`,
    );

    const cli = join(import.meta.dir, "cli.ts");
    const result = Bun.spawnSync([process.execPath, cli, "sync", "--dryrun"], {
      env: { ...process.env, SLINKY_REPO: host },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unknown option for sync: --dryrun");
  });

  test("rehashes an edited local skill", () => {
    const host = mkdtempSync(join(tmpdir(), "slinky-cli-"));
    roots.push(host);
    mkdirSync(join(host, "skills", "foo"), { recursive: true });
    writeFileSync(join(host, "skills", "foo", "SKILL.md"), "# Foo\n");
    writeFileSync(
      join(host, "skills.manifest.json"),
      `${JSON.stringify({
        version: 1,
        skills: {
          foo: {
            origin: "local",
            path: "skills/foo",
            contentHash: "0".repeat(64),
          },
        },
        profiles: {},
      })}\n`,
    );

    const cli = join(import.meta.dir, "cli.ts");
    const result = Bun.spawnSync([process.execPath, cli, "rehash", "foo"], {
      env: { ...process.env, SLINKY_REPO: host },
    });
    const manifest = JSON.parse(readFileSync(join(host, "skills.manifest.json"), "utf8")) as {
      skills: { foo: { contentHash: string } };
    };

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("foo: refreshed manifest hash");
    expect(manifest.skills.foo.contentHash).not.toBe("0".repeat(64));
    expect(manifest.skills.foo.contentHash).toHaveLength(64);
  });
});
