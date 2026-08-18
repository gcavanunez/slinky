import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { Manifest } from "./domain/model.ts";
import { contentHash } from "./lib/hash.ts";

const roots: string[] = [];
const decodeEncodedManifest = Schema.decodeUnknownSync(Schema.toEncoded(Manifest));
const gitIdentity = {
  GIT_AUTHOR_NAME: "Slinky Test",
  GIT_AUTHOR_EMAIL: "slinky@example.com",
  GIT_COMMITTER_NAME: "Slinky Test",
  GIT_COMMITTER_EMAIL: "slinky@example.com",
};

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

function runGit(repo: string, args: ReadonlyArray<string>) {
  return Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: { ...process.env, ...gitIdentity },
  });
}

function initializeGitFixture(host: string, home: string): void {
  writeFileSync(join(host, ".gitignore"), ".local/\n");
  for (const name of ["foo", "bar"]) {
    const rehash = runCli(host, home, ["rehash", name]);
    if (rehash.exitCode !== 0) throw new Error(rehash.stderr.toString());
  }
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["commit", "-qm", "Initial catalog"],
  ]) {
    const result = runGit(host, args);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
}

function addDriftingVendor(f: ReturnType<typeof fixture>, name = "drifting"): void {
  const baseline = join(f.host, "vendor", "acme", name);
  const live = join(f.home, ".agents", "skills", name);
  mkdirSync(baseline, { recursive: true });
  mkdirSync(live, { recursive: true });
  writeFileSync(join(baseline, "SKILL.md"), `# baseline ${name}\n`);
  writeFileSync(join(live, "SKILL.md"), `# live ${name}\n`);
  const manifest = JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8"));
  manifest.skills[name] = {
    origin: "vendor",
    path: `vendor/acme/${name}`,
    contentHash: contentHash(baseline),
    upstream: { kind: "unknown", note: "test" },
    vendoredAt: null,
  };
  writeFileSync(join(f.host, "skills.manifest.json"), `${JSON.stringify(manifest)}\n`);
}

function recordingPager(root: string, name: "hunk" | "delta"): string {
  const bin = join(root, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, name);
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\n' "$@" > "$HOME/${name}-args"
printf 'x' >> "$HOME/${name}-invocations"
cat > "$HOME/${name}-input"
`,
  );
  chmodSync(executable, 0o755);
  return bin;
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
    const manifest = decodeEncodedManifest(JSON.parse(readFileSync(join(host, "skills.manifest.json"), "utf8")));
    const foo = manifest.skills.foo;
    if (!foo) throw new Error("expected foo in manifest");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("foo: refreshed manifest hash");
    expect(foo.contentHash).not.toBe("0".repeat(64));
    expect(foo.contentHash).toHaveLength(64);
  });
});

describe("save", () => {
  test("verifies and commits catalog paths without including unrelated staged files", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    writeFileSync(join(f.host, "skills", "foo", "SKILL.md"), "# foo v2\n");
    expect(runCli(f.host, f.home, ["rehash", "foo"]).exitCode).toBe(0);
    writeFileSync(join(f.host, "notes.txt"), "keep staged\n");
    writeFileSync(join(f.host, "skills", "notes.txt"), "not a skill\n");
    expect(runGit(f.host, ["add", "notes.txt"]).exitCode).toBe(0);

    const result = runCli(f.host, f.home, ["save", "--message", "Update foo"], gitIdentity);

    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    expect(result.stdout.toString()).toContain("saved catalog as");
    expect(runGit(f.host, ["log", "-1", "--pretty=%s"]).stdout.toString().trim()).toBe("Update foo");
    const committed = runGit(f.host, ["show", "--pretty=", "--name-only", "HEAD"]).stdout.toString().trim().split("\n");
    expect(committed).toContain("skills.manifest.json");
    expect(committed).toContain("skills/foo/SKILL.md");
    expect(committed).not.toContain("notes.txt");
    expect(runGit(f.host, ["diff", "--cached", "--name-only"]).stdout.toString().trim()).toBe("notes.txt");
    expect(runGit(f.host, ["status", "--short", "--", "skills/notes.txt"]).stdout.toString().trim()).toBe("?? skills/notes.txt");
  });

  test("uses the default message and succeeds without changes", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    writeFileSync(join(f.host, "skills", "foo", "SKILL.md"), "# foo v2\n");
    expect(runCli(f.host, f.home, ["rehash", "foo"]).exitCode).toBe(0);

    const saved = runCli(f.host, f.home, ["save"], { ...gitIdentity, GIT_DIR: join(f.root, "not-the-host.git") });
    if (saved.exitCode !== 0) throw new Error(`${saved.stderr.toString()}\n${saved.stdout.toString()}`);
    expect(runGit(f.host, ["log", "-1", "--pretty=%s"]).stdout.toString().trim()).toBe("Update skills catalog");

    const unchanged = runCli(f.host, f.home, ["save"], gitIdentity);
    expect(unchanged.exitCode).toBe(0);
    expect(unchanged.stdout.toString()).toContain("catalog already saved; nothing to commit");
  });

  test("commits verified catalog content without imposing a whitespace policy", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    writeFileSync(join(f.host, "skills", "foo", "SKILL.md"), "# foo v2\n\n");
    expect(runCli(f.host, f.home, ["rehash", "foo"]).exitCode).toBe(0);

    const result = runCli(f.host, f.home, ["save"], gitIdentity);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("saved catalog as");
  });

  test("refuses to commit an unindexed catalog directory", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    mkdirSync(join(f.host, "vendor", "acme", "unknown"), { recursive: true });
    writeFileSync(join(f.host, "vendor", "acme", "unknown", "SKILL.md"), "# unknown\n");

    const result = runCli(f.host, f.home, ["save"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unindexed catalog skill: vendor/acme/unknown");
    expect(runGit(f.host, ["log", "-1", "--pretty=%s"]).stdout.toString().trim()).toBe("Initial catalog");
  });

  test("refuses a host nested inside another Git repository", () => {
    const f = fixture();
    writeFileSync(join(f.root, ".gitignore"), "host/.local/\n");
    for (const name of ["foo", "bar"]) expect(runCli(f.host, f.home, ["rehash", name]).exitCode).toBe(0);
    for (const args of [
      ["init", "-q"],
      ["add", "."],
      ["commit", "-qm", "Outer repository"],
    ]) {
      const result = runGit(f.root, args);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }
    writeFileSync(join(f.host, "skills", "foo", "SKILL.md"), "# foo v2\n");
    expect(runCli(f.host, f.home, ["rehash", "foo"]).exitCode).toBe(0);

    const result = runCli(f.host, f.home, ["save"], gitIdentity);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("skills host must be a Git repository root");
    expect(runGit(f.root, ["log", "-1", "--pretty=%s"]).stdout.toString().trim()).toBe("Outer repository");
  });

  test("restores the Git index when the commit fails", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    writeFileSync(join(f.host, "skills", "foo", "SKILL.md"), "# foo v2\n");
    expect(runCli(f.host, f.home, ["rehash", "foo"]).exitCode).toBe(0);
    writeFileSync(join(f.host, "notes.txt"), "keep staged\n");
    expect(runGit(f.host, ["add", "notes.txt"]).exitCode).toBe(0);
    const hook = join(f.host, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    const result = runCli(f.host, f.home, ["save"], gitIdentity);

    expect(result.exitCode).toBe(1);
    expect(runGit(f.host, ["diff", "--cached", "--name-only"]).stdout.toString().trim()).toBe("notes.txt");
    expect(runGit(f.host, ["diff", "--name-only"]).stdout.toString().trim().split("\n")).toEqual(["skills.manifest.json", "skills/foo/SKILL.md"]);
    expect(runGit(f.host, ["log", "-1", "--pretty=%s"]).stdout.toString().trim()).toBe("Initial catalog");
  });

  test("refuses symlinks that are excluded from content verification", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    writeFileSync(join(f.host, "outside.txt"), "not hashed\n");
    symlinkSync(join(f.host, "outside.txt"), join(f.host, "skills", "foo", "outside.txt"));

    const result = runCli(f.host, f.home, ["save"], gitIdentity);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("catalog verification problem");
    expect(result.stdout.toString()).toContain("repo copy contains symlink(s): outside.txt");
    expect(runGit(f.host, ["log", "-1", "--pretty=%s"]).stdout.toString().trim()).toBe("Initial catalog");
  });
});

describe("diff pagers", () => {
  test.each([
    { flags: ["--hunk"], pager: "hunk" as const, args: ["patch", "-"] },
    { flags: ["--delta"], pager: "delta" as const, args: [] },
    { flags: ["--pager", "hunk"], pager: "hunk" as const, args: ["patch", "-"] },
    { flags: ["--pager", "delta"], pager: "delta" as const, args: [] },
  ])("streams a clean patch through $pager with $flags", ({ flags, pager, args }) => {
    const f = fixture();
    addDriftingVendor(f);
    const bin = recordingPager(f.root, pager);

    const result = runCli(f.host, f.home, ["diff", "drifting", ...flags], { PATH: `${bin}:${process.env.PATH ?? ""}` });

    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    expect(
      readFileSync(join(f.home, `${pager}-args`), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean),
    ).toEqual([...args]);
    const input = readFileSync(join(f.home, `${pager}-input`), "utf8");
    expect(input).toContain("diff -ruN");
    expect(input).toContain("-# baseline");
    expect(input).toContain("+# live");
    expect(result.stdout.toString()).not.toContain("differs from repo baseline");
  });

  test("opens one Hunk session containing every selected drifting skill", () => {
    const f = fixture();
    addDriftingVendor(f, "first");
    addDriftingVendor(f, "second");
    const bin = recordingPager(f.root, "hunk");

    const result = runCli(f.host, f.home, ["diff", "first", "second", "--hunk"], { PATH: `${bin}:${process.env.PATH ?? ""}` });

    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    expect(readFileSync(join(f.home, "hunk-invocations"), "utf8")).toBe("x");
    const input = readFileSync(join(f.home, "hunk-input"), "utf8");
    expect(input).toContain("-# baseline first");
    expect(input).toContain("+# live first");
    expect(input).toContain("-# baseline second");
    expect(input).toContain("+# live second");
  });

  test("rejects conflicting pager flags", () => {
    const f = fixture();
    addDriftingVendor(f);

    const result = runCli(f.host, f.home, ["diff", "drifting", "--hunk", "--delta"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("choose only one diff pager");
  });

  test("reports a missing pager as an external tool failure", () => {
    const f = fixture();
    addDriftingVendor(f);
    const diff = Bun.which("diff");
    if (!diff) throw new Error("diff is required for this test");
    symlinkSync(diff, join(f.root, "diff"));

    const result = runCli(f.host, f.home, ["diff", "drifting", "--hunk"], { PATH: f.root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('Executable not found in $PATH: "hunk"');
  });

  test("does not open the pager when diff generation fails", () => {
    const f = fixture();
    addDriftingVendor(f);
    const bin = recordingPager(f.root, "hunk");
    const diff = join(bin, "diff");
    writeFileSync(diff, "#!/bin/sh\nprintf 'broken diff' >&2\nexit 2\n");
    chmodSync(diff, 0o755);

    const result = runCli(f.host, f.home, ["diff", "drifting", "--hunk"], { PATH: `${bin}:${process.env.PATH ?? ""}` });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("broken diff");
    expect(existsSync(join(f.home, "hunk-invocations"))).toBe(false);
  });
});

describe("CLI catalog actions", () => {
  /** Stub `npx` that installs into the repo staging inbox, as project-scoped skills.sh does. */
  function stagingNpx(root: string, names: ReadonlyArray<string>): string {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const npx = join(bin, "npx");
    const lock = JSON.stringify({
      version: 1,
      skills: Object.fromEntries(names.map((name) => [name, { source: "kitlangton/skills", sourceType: "github", computedHash: "c".repeat(64) }])),
    });
    writeFileSync(
      npx,
      `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/npx-args"
printf '%s\\n' "$PWD" > "$HOME/npx-cwd"
${names.map((name) => `mkdir -p "$PWD/.agents/skills/${name}"\nprintf '%s\\n' '# ${name}' > "$PWD/.agents/skills/${name}/SKILL.md"`).join("\n")}
mkdir -p "$PWD/.claude/skills"
${names.map((name) => `ln -sfn "../../.agents/skills/${name}" "$PWD/.claude/skills/${name}"`).join("\n")}
printf '%s\\n' '${lock}' > "$PWD/skills-lock.json"
`,
    );
    chmodSync(npx, 0o755);
    return bin;
  }

  test("installs project-scoped, vendors, indexes, and clears the staging inbox", () => {
    const f = fixture();
    const bin = stagingNpx(f.root, ["effect"]);

    const result = runCli(f.host, f.home, ["skills", "add", "kitlangton/skills", "--skill", "effect"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    const manifest = decodeEncodedManifest(JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8")));

    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    // Project scope, not --global: that is what keeps the install inside the repo.
    expect(readFileSync(join(f.home, "npx-args"), "utf8").trim().split("\n")).toEqual([
      "-y",
      "skills",
      "add",
      "kitlangton/skills",
      "--project",
      "-a",
      "universal",
      "--skill",
      "effect",
      "--yes",
    ]);
    expect(readFileSync(join(f.home, "npx-cwd"), "utf8").trim()).toBe(f.host);
    expect(manifest.skills.effect).toEqual({
      origin: "vendor",
      path: "vendor/kitlangton/effect",
      contentHash: expect.any(String),
      // No skillPath in the lock, so there is nothing to look up upstream.
      upstream: { kind: "github", repository: "kitlangton/skills", url: null, tracking: { kind: "untracked" } },
      vendoredAt: expect.any(String),
    });
    expect(readFileSync(join(f.host, "vendor", "kitlangton", "effect", "SKILL.md"), "utf8")).toBe("# effect\n");
    // Staging inbox and its residue are cleared.
    expect(existsSync(join(f.host, ".agents", "skills", "effect"))).toBe(false);
    expect(existsSync(join(f.host, ".claude", "skills", "effect"))).toBe(false);
    expect(existsSync(join(f.host, "skills-lock.json"))).toBe(false);
  });

  test("without --skill it defers discovery to skills.sh and adopts everything staged", () => {
    const f = fixture();
    const bin = stagingNpx(f.root, ["effect", "cause"]);

    const result = runCli(f.host, f.home, ["skills", "add", "kitlangton/skills"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    const manifest = decodeEncodedManifest(JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8")));

    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    // No --yes: that would make skills.sh silently select every skill instead of asking.
    expect(readFileSync(join(f.home, "npx-args"), "utf8").trim().split("\n")).toEqual(["-y", "skills", "add", "kitlangton/skills", "--project", "-a", "universal"]);
    expect(manifest.skills.effect?.path).toBe("vendor/kitlangton/effect");
    expect(manifest.skills.cause?.path).toBe("vendor/kitlangton/cause");
    expect(existsSync(join(f.host, "skills-lock.json"))).toBe(false);
  });

  test("adopt discards a staging copy that duplicates an indexed baseline", () => {
    const f = fixture();
    // `foo` is already indexed as skills/foo with the same content.
    mkdirSync(join(f.host, ".agents", "skills", "foo"), { recursive: true });
    writeFileSync(join(f.host, ".agents", "skills", "foo", "SKILL.md"), "# foo\n");
    const rehash = runCli(f.host, f.home, ["rehash", "foo"]);
    expect(rehash.exitCode).toBe(0);

    const listing = runCli(f.host, f.home, ["adopt"]);
    expect(listing.stdout.toString()).toContain("staging copy is redundant");
    expect(existsSync(join(f.host, ".agents", "skills", "foo"))).toBe(true);

    const applied = runCli(f.host, f.home, ["adopt", "--all"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout.toString()).toContain("removed the redundant staging copy");
    expect(existsSync(join(f.host, ".agents", "skills", "foo"))).toBe(false);
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
