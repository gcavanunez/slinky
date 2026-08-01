import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

function fixture(disabledSkills: ReadonlyArray<string> = []) {
  const root = mkdtempSync(join(tmpdir(), "slinky-cli-actions-"));
  roots.push(root);
  const host = join(root, "host");
  const home = join(root, "home");
  mkdirSync(join(host, ".local"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const name of ["foo", "bar"]) {
    mkdirSync(join(host, "skills", name), { recursive: true });
    writeFileSync(join(host, "skills", name, "SKILL.md"), `# ${name}\n`);
  }
  writeFileSync(
    join(host, "skills.manifest.json"),
    `${JSON.stringify({
      version: 1,
      skills: {
        foo: { origin: "local", path: "skills/foo", contentHash: "a".repeat(64) },
        bar: { origin: "local", path: "skills/bar", contentHash: "b".repeat(64) },
      },
      profiles: { focus: ["foo"] },
    })}\n`,
  );
  const statePath = join(host, ".local", "state.json");
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        disabledSkills,
        activeProfile: null,
        projectLinks: [],
        recentProjects: [],
      },
      null,
      2,
    )}\n`,
  );
  return { root, host, home, statePath };
}

function runCli(host: string, home: string, args: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) {
  const cli = join(import.meta.dir, "cli.ts");
  return Bun.spawnSync([process.execPath, cli, ...args], {
    env: { ...process.env, HOME: home, SLINKY_REPO: host, ...env },
  });
}

function stateAt(path: string): {
  disabledSkills: string[];
  activeProfile: string | null;
  projectLinks: Array<{ skill: string; project: string }>;
} {
  return JSON.parse(readFileSync(path, "utf8"));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI options", () => {
  test("rejects a misspelled dry-run option instead of syncing", () => {
    const host = mkdtempSync(join(tmpdir(), "slinky-cli-"));
    roots.push(host);
    writeFileSync(join(host, "skills.manifest.json"), `${JSON.stringify({ version: 1, skills: {}, profiles: {} })}\n`);

    const cli = join(import.meta.dir, "cli.ts");
    const result = Bun.spawnSync([process.execPath, cli, "sync", "--dryrun"], {
      env: { ...process.env, SLINKY_REPO: host },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Unrecognized flag: --dryrun");
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

describe("CLI catalog actions", () => {
  test("installs, vendors, and indexes a skill through skills.sh", () => {
    const f = fixture();
    mkdirSync(join(f.host, "vendor", "kitlangton", "effect"), { recursive: true });
    writeFileSync(join(f.host, "vendor", "kitlangton", "effect", "SKILL.md"), "# effect\n");
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    const npx = join(bin, "npx");
    writeFileSync(
      npx,
      `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/npx-args"
mkdir -p "$HOME/.agents/skills/effect"
printf '%s\\n' '# effect' > "$HOME/.agents/skills/effect/SKILL.md"
printf '%s\\n' '{"skills":{"effect":{"source":"kitlangton/skills","sourceType":"github","sourceUrl":"https://github.com/kitlangton/skills"}}}' > "$HOME/.agents/.skill-lock.json"
`,
    );
    chmodSync(npx, 0o755);

    const result = runCli(f.host, f.home, ["skills", "add", "kitlangton/skills", "--skill", "effect"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    const manifest = JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8")) as {
      skills: Record<
        string,
        {
          origin: string;
          path: string;
          contentHash: string;
          upstream?: { kind: string; repository?: string; url?: string; tracking?: { kind: string } };
          vendoredAt?: string;
        }
      >;
    };

    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    expect(readFileSync(join(f.home, "npx-args"), "utf8").trim().split("\n")).toEqual(["-y", "skills", "add", "kitlangton/skills", "--skill", "effect", "--global", "--yes"]);
    expect(manifest.skills.effect).toEqual({
      origin: "vendor",
      path: "vendor/kitlangton/effect",
      contentHash: expect.any(String),
      upstream: {
        kind: "github",
        repository: "kitlangton/skills",
        url: "https://github.com/kitlangton/skills",
        tracking: { kind: "untracked" },
      },
      vendoredAt: expect.any(String),
    });
    expect(readFileSync(join(f.host, "vendor", "kitlangton", "effect", "SKILL.md"), "utf8")).toBe("# effect\n");
  });

  test("status reports host skill directories missing from the manifest", () => {
    const f = fixture();
    for (const path of ["skills/draft", "vendor/acme/effect", ".agents/skills/manual"]) {
      mkdirSync(join(f.host, path), { recursive: true });
      writeFileSync(join(f.host, path, "SKILL.md"), `# ${path}\n`);
    }

    const result = runCli(f.host, f.home, ["status"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain("unindexed skills in host:");
    expect(output).toContain("skills/draft");
    expect(output).toContain("vendor/acme/effect");
    expect(output).toContain(".agents/skills/manual");
  });

  test("enable and profile dry runs preserve state bytes and global stores", () => {
    const f = fixture(["foo"]);
    const before = readFileSync(f.statePath);

    const enable = runCli(f.host, f.home, ["enable", "foo", "--dry-run"]);
    const profile = runCli(f.host, f.home, ["profile", "apply", "focus", "--dry-run"]);

    expect(enable.exitCode).toBe(0);
    expect(enable.stdout.toString()).toContain("would ensure-agents-symlink foo");
    expect(profile.exitCode).toBe(0);
    expect(profile.stdout.toString()).toContain("would ensure-agents-symlink foo");
    expect(readFileSync(f.statePath)).toEqual(before);
    expect(() => lstatSync(join(f.home, ".agents"))).toThrow();
    expect(() => lstatSync(join(f.home, ".claude"))).toThrow();
  });

  test("applied enable and disable update state and global stores", () => {
    const f = fixture(["foo", "bar"]);

    const enable = runCli(f.host, f.home, ["enable", "foo", "bar"]);
    expect(enable.exitCode).toBe(0);
    expect(stateAt(f.statePath).disabledSkills).toEqual([]);
    for (const name of ["foo", "bar"]) {
      expect(lstatSync(join(f.home, ".agents", "skills", name)).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(f.home, ".claude", "skills", name)).isSymbolicLink()).toBe(true);
    }

    const disable = runCli(f.host, f.home, ["disable", "foo", "bar"]);
    expect(disable.exitCode).toBe(0);
    expect(stateAt(f.statePath).disabledSkills).toEqual(["bar", "foo"]);
    expect(() => lstatSync(join(f.home, ".agents", "skills", "foo"))).toThrow();
    expect(() => lstatSync(join(f.home, ".agents", "skills", "bar"))).toThrow();
  });

  test("link followed by unlink updates both project targets and state", () => {
    const f = fixture();
    const project = join(f.root, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });

    const link = runCli(f.host, f.home, ["link", "foo", project, "--symlink", "--no-exclude"]);
    expect(link.exitCode).toBe(0);
    expect(link.stdout.toString()).toContain(`linked \u001b[1mfoo\u001b[0m (symlink) into ${project}`);
    expect(stateAt(f.statePath).projectLinks).toHaveLength(1);
    expect(lstatSync(join(project, ".agents", "skills", "foo")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(project, ".claude", "skills", "foo")).isSymbolicLink()).toBe(true);

    const unlink = runCli(f.host, f.home, ["unlink", "foo", project]);
    expect(unlink.exitCode).toBe(0);
    expect(unlink.stdout.toString()).toContain(`unlinked \u001b[1mfoo\u001b[0m from ${project}`);
    expect(stateAt(f.statePath).projectLinks).toEqual([]);
    expect(() => lstatSync(join(project, ".agents", "skills", "foo"))).toThrow();
    expect(() => lstatSync(join(project, ".claude", "skills", "foo"))).toThrow();
  });
});
