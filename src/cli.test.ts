import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import packageJson from "../package.json" with { type: "json" };
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

function attachRemote(f: ReturnType<typeof fixture>): string {
  const saved = runCli(f.host, f.home, ["save"], gitIdentity);
  if (saved.exitCode !== 0) throw new Error(`${saved.stderr.toString()}\n${saved.stdout.toString()}`);
  const remote = join(f.root, "remote.git");
  for (const args of [
    ["init", "--bare", "-q", remote],
    ["-C", f.host, "branch", "-M", "main"],
    ["-C", f.host, "remote", "add", "origin", remote],
    ["-C", f.host, "push", "-qu", "origin", "main"],
    ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], { env: { ...process.env, ...gitIdentity } });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  return remote;
}

function removeBarAndPublish(f: ReturnType<typeof fixture>): void {
  const manifest = JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8"));
  delete manifest.skills.bar;
  writeFileSync(join(f.host, "skills.manifest.json"), `${JSON.stringify(manifest)}\n`);
  rmSync(join(f.host, "skills", "bar"), { recursive: true });
  const saved = runCli(f.host, f.home, ["save"], gitIdentity);
  if (saved.exitCode !== 0) throw new Error(`${saved.stderr.toString()}\n${saved.stdout.toString()}`);
  const pushed = runGit(f.host, ["push"]);
  if (pushed.exitCode !== 0) throw new Error(pushed.stderr.toString());
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
  test("reports the installed version as a command and a flag", () => {
    const f = fixture();

    const command = runCli(f.host, f.home, ["version"]);
    const flag = runCli(f.host, f.home, ["--version"]);

    expect(command.exitCode).toBe(0);
    expect(command.stdout.toString().trim()).toBe(`slinky ${packageJson.version}`);
    expect(flag.exitCode).toBe(0);
    expect(flag.stdout.toString()).toContain(packageJson.version);
  });

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

  test("rehashes every stale local skill when none are named", () => {
    const f = fixture();
    addDriftingVendor(f);
    writeFileSync(join(f.host, "skills", "foo", "SKILL.md"), "# foo v2\n");

    const result = runCli(f.host, f.home, ["rehash"]);
    const manifest = decodeEncodedManifest(JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8")));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("foo: refreshed manifest hash");
    expect(result.stdout.toString()).toContain("bar: refreshed manifest hash");
    expect(manifest.skills.foo?.contentHash).toBe(contentHash(join(f.host, "skills", "foo")));
    expect(manifest.skills.bar?.contentHash).toBe(contentHash(join(f.host, "skills", "bar")));
  });

  test("leaves a drifting vendor baseline for the vendor command", () => {
    const f = fixture();
    addDriftingVendor(f);
    const before = decodeEncodedManifest(JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8")));
    writeFileSync(join(f.host, "vendor", "acme", "drifting", "SKILL.md"), "# hand edited\n");

    const sweep = runCli(f.host, f.home, ["rehash"]);
    const named = runCli(f.host, f.home, ["rehash", "drifting"]);
    const manifest = decodeEncodedManifest(JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8")));

    expect(sweep.exitCode).toBe(0);
    expect(sweep.stdout.toString()).not.toContain("drifting");
    expect(named.exitCode).toBe(1);
    expect(named.stderr.toString()).toContain("drifting is a vendor skill");
    expect(manifest.skills.drifting?.contentHash).toBe(before.skills.drifting?.contentHash);
  });

  test("reports when no local skill has drifted", () => {
    const f = fixture();
    expect(runCli(f.host, f.home, ["rehash"]).exitCode).toBe(0);

    const result = runCli(f.host, f.home, ["rehash"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("all local skills already current");
  });
});

describe("config", () => {
  const configAt = (home: string) => JSON.parse(readFileSync(join(home, ".config", "slinky", "config.json"), "utf8"));

  test("records a diff pager and keeps it across a re-init", () => {
    const f = fixture();
    expect(runCli(f.host, f.home, ["init", f.host]).exitCode).toBe(0);

    const set = runCli(f.host, f.home, ["config", "diff-pager", "delta"]);

    expect(set.exitCode).toBe(0);
    expect(set.stdout.toString()).toContain("diff pager set to delta");
    expect(configAt(f.home).diffPager).toBe("delta");
    // Re-running init must not drop the pager: it rewrites the whole file.
    expect(runCli(f.host, f.home, ["init", f.host]).exitCode).toBe(0);
    expect(configAt(f.home).diffPager).toBe("delta");
    expect(runCli(f.host, f.home, ["config"]).stdout.toString()).toContain("delta");
  });

  test("clears the diff pager with none", () => {
    const f = fixture();
    expect(runCli(f.host, f.home, ["init", f.host]).exitCode).toBe(0);
    expect(runCli(f.host, f.home, ["config", "diff-pager", "hunk"]).exitCode).toBe(0);

    const cleared = runCli(f.host, f.home, ["config", "diff-pager", "none"]);

    expect(cleared.exitCode).toBe(0);
    expect(configAt(f.home)).not.toHaveProperty("diffPager");
    expect(runCli(f.host, f.home, ["config", "diff-pager"]).stdout.toString()).toContain("none");
  });

  test("rejects a pager it cannot drive", () => {
    const f = fixture();
    expect(runCli(f.host, f.home, ["init", f.host]).exitCode).toBe(0);

    const result = runCli(f.host, f.home, ["config", "diff-pager", "bat"]);

    expect(result.exitCode).toBe(1);
    expect(configAt(f.home)).not.toHaveProperty("diffPager");
  });

  test("records an editor and reports it alongside the pager", () => {
    const f = fixture();
    expect(runCli(f.host, f.home, ["init", f.host]).exitCode).toBe(0);

    const set = runCli(f.host, f.home, ["config", "editor", "code -w"]);

    expect(set.exitCode).toBe(0);
    expect(configAt(f.home).editor).toBe("code -w");
    expect(runCli(f.host, f.home, ["config"]).stdout.toString()).toContain("code -w");
    // A recorded editor beats both environment variables.
    expect(runCli(f.host, f.home, ["config", "editor"], { VISUAL: "vim", EDITOR: "nano" }).stdout.toString().trim()).toBe("code -w");
  });

  test("falls back through $VISUAL, $EDITOR, then nvim", () => {
    const f = fixture();
    expect(runCli(f.host, f.home, ["init", f.host]).exitCode).toBe(0);
    const read = (env: Record<string, string | undefined>) => runCli(f.host, f.home, ["config", "editor"], env).stdout.toString().trim();

    expect(read({ VISUAL: "vim", EDITOR: "nano" })).toBe("vim");
    expect(read({ VISUAL: undefined, EDITOR: "nano" })).toBe("nano");
    expect(read({ VISUAL: undefined, EDITOR: undefined })).toBe("nvim");
  });

  test("clears the editor back to the environment fallback", () => {
    const f = fixture();
    expect(runCli(f.host, f.home, ["init", f.host]).exitCode).toBe(0);
    expect(runCli(f.host, f.home, ["config", "editor", "code -w"]).exitCode).toBe(0);

    const cleared = runCli(f.host, f.home, ["config", "editor", "none"]);

    expect(cleared.exitCode).toBe(0);
    expect(configAt(f.home)).not.toHaveProperty("editor");
    expect(runCli(f.host, f.home, ["config", "editor"], { VISUAL: "vim", EDITOR: undefined }).stdout.toString().trim()).toBe("vim");
  });

  test("keeps the pager and editor independent when setting either", () => {
    const f = fixture();
    expect(runCli(f.host, f.home, ["init", f.host]).exitCode).toBe(0);
    expect(runCli(f.host, f.home, ["config", "diff-pager", "delta"]).exitCode).toBe(0);
    expect(runCli(f.host, f.home, ["config", "editor", "code -w"]).exitCode).toBe(0);

    expect(configAt(f.home).diffPager).toBe("delta");
    expect(configAt(f.home).editor).toBe("code -w");
    expect(runCli(f.host, f.home, ["config", "diff-pager", "none"]).exitCode).toBe(0);
    expect(configAt(f.home).editor).toBe("code -w");
  });

  test("diff uses the configured pager without a flag, and --no-pager opts out", () => {
    const f = fixture();
    addDriftingVendor(f);
    expect(runCli(f.host, f.home, ["init", f.host]).exitCode).toBe(0);
    expect(runCli(f.host, f.home, ["config", "diff-pager", "delta"]).exitCode).toBe(0);
    const bin = recordingPager(f.root, "delta");
    const path = { PATH: `${bin}:${process.env.PATH ?? ""}` };

    const paged = runCli(f.host, f.home, ["diff", "drifting"], path);

    if (paged.exitCode !== 0) throw new Error(`${paged.stderr.toString()}\n${paged.stdout.toString()}`);
    expect(readFileSync(join(f.home, "delta-input"), "utf8")).toContain("+# live");
    rmSync(join(f.home, "delta-invocations"));

    const inline = runCli(f.host, f.home, ["diff", "drifting", "--no-pager"], path);

    expect(inline.exitCode).toBe(0);
    expect(existsSync(join(f.home, "delta-invocations"))).toBe(false);
    expect(inline.stdout.toString()).toContain("differs from repo baseline");
  });

  test("refuses a pager flag combined with --no-pager", () => {
    const f = fixture();
    addDriftingVendor(f);

    const result = runCli(f.host, f.home, ["diff", "drifting", "--delta", "--no-pager"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--no-pager cannot be combined");
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
    expect(committed).toContain(".skill-lock.json");
    expect(committed).toContain("skills/foo/SKILL.md");
    expect(committed).not.toContain("notes.txt");
    expect(runGit(f.host, ["diff", "--cached", "--name-only"]).stdout.toString().trim()).toBe("notes.txt");
    expect(runGit(f.host, ["status", "--short", "--", "skills/notes.txt"]).stdout.toString().trim()).toBe("?? skills/notes.txt");
  });

  test("refreshes stale local hashes itself and reports what it refreshed", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    writeFileSync(join(f.host, "skills", "foo", "SKILL.md"), "# foo v2\n");

    const result = runCli(f.host, f.home, ["save", "--message", "Update foo"], gitIdentity);
    const manifest = decodeEncodedManifest(JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8")));

    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    expect(result.stdout.toString()).toContain("foo: refreshed manifest hash");
    expect(result.stdout.toString()).toContain("saved catalog as");
    expect(manifest.skills.foo?.contentHash).toBe(contentHash(join(f.host, "skills", "foo")));
    const committed = runGit(f.host, ["show", "--pretty=", "--name-only", "HEAD"]).stdout.toString().trim().split("\n");
    expect(committed).toContain("skills.manifest.json");
    expect(committed).toContain("skills/foo/SKILL.md");
    expect(runGit(f.host, ["status", "--porcelain"]).stdout.toString().trim()).toBe("");
  });

  test("still refuses to commit a hand-edited vendor baseline", () => {
    const f = fixture();
    addDriftingVendor(f);
    initializeGitFixture(f.host, f.home);
    writeFileSync(join(f.host, "skills", "foo", "SKILL.md"), "# foo v2\n");
    writeFileSync(join(f.host, "vendor", "acme", "drifting", "SKILL.md"), "# hand edited\n");

    const result = runCli(f.host, f.home, ["save"], gitIdentity);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("drifting: repo copy hash mismatch");
    expect(result.stderr.toString()).toContain("catalog verification problem");
    expect(runGit(f.host, ["log", "-1", "--pretty=%s"]).stdout.toString().trim()).toBe("Initial catalog");
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

  test("stages catalog paths removed from the current manifest", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    const manifest = JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8"));
    delete manifest.skills.foo;
    manifest.profiles = {};
    writeFileSync(join(f.host, "skills.manifest.json"), `${JSON.stringify(manifest)}\n`);
    rmSync(join(f.host, "skills", "foo"), { recursive: true });

    const result = runCli(f.host, f.home, ["save"], gitIdentity);

    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    expect(runGit(f.host, ["show", "--pretty=", "--name-status", "HEAD"]).stdout.toString()).toContain("D\tskills/foo/SKILL.md");
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

describe("remote catalog sync", () => {
  test("push publishes the saved branch and refuses a dirty worktree", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    const remote = attachRemote(f);
    writeFileSync(join(f.host, "skills", "foo", "SKILL.md"), "# foo v2\n");
    expect(runCli(f.host, f.home, ["rehash", "foo"]).exitCode).toBe(0);
    expect(runCli(f.host, f.home, ["save"], gitIdentity).exitCode).toBe(0);
    expect(runGit(f.host, ["config", "remote.pushDefault", "not-the-upstream"]).exitCode).toBe(0);

    const pushed = runCli(f.host, f.home, ["push"]);

    if (pushed.exitCode !== 0) throw new Error(`${pushed.stderr.toString()}\n${pushed.stdout.toString()}`);
    expect(runGit(remote, ["rev-parse", "refs/heads/main"]).stdout.toString()).toEqual(runGit(f.host, ["rev-parse", "HEAD"]).stdout.toString());
    writeFileSync(join(f.host, "notes.txt"), "not saved\n");
    const dirty = runCli(f.host, f.home, ["push"]);
    expect(dirty.exitCode).toBe(1);
    expect(dirty.stderr.toString()).toContain("worktree must be clean");
  });

  test("pull fast-forwards, removes retired globals, and preserves local state", () => {
    const publisher = fixture();
    initializeGitFixture(publisher.host, publisher.home);
    const remote = attachRemote(publisher);
    const subscriber = join(publisher.root, "subscriber");
    const subscriberHome = join(publisher.root, "subscriber-home");
    expect(Bun.spawnSync(["git", "clone", "-q", remote, subscriber]).exitCode).toBe(0);
    mkdirSync(join(subscriber, ".local"), { recursive: true });
    mkdirSync(subscriberHome, { recursive: true });
    writeFileSync(
      join(subscriber, ".local", "state.json"),
      `${JSON.stringify({ version: 1, disabledSkills: ["foo"], activeProfile: null, projectLinks: [], recentProjects: [] })}\n`,
    );
    expect(runCli(subscriber, subscriberHome, ["sync"]).exitCode).toBe(0);
    expect(lstatSync(join(subscriberHome, ".agents", "skills", "bar")).isSymbolicLink()).toBe(true);

    const manifest = JSON.parse(readFileSync(join(publisher.host, "skills.manifest.json"), "utf8"));
    delete manifest.skills.bar;
    mkdirSync(join(publisher.host, "skills", "baz"), { recursive: true });
    writeFileSync(join(publisher.host, "skills", "baz", "SKILL.md"), "# baz\n");
    manifest.skills.baz = { origin: "local", path: "skills/baz", contentHash: "0".repeat(64) };
    writeFileSync(join(publisher.host, "skills.manifest.json"), `${JSON.stringify(manifest)}\n`);
    rmSync(join(publisher.host, "skills", "bar"), { recursive: true });
    expect(runCli(publisher.host, publisher.home, ["rehash", "baz"]).exitCode).toBe(0);
    expect(runCli(publisher.host, publisher.home, ["save"], gitIdentity).exitCode).toBe(0);
    expect(runGit(publisher.host, ["push"]).exitCode).toBe(0);

    const preview = runCli(subscriber, subscriberHome, ["sync", "--dry-run"]);
    if (preview.exitCode !== 0) throw new Error(`${preview.stderr.toString()}\n${preview.stdout.toString()}`);
    expect(preview.stdout.toString()).toContain("would ensure-agents-symlink baz");

    const pulled = runCli(subscriber, subscriberHome, ["pull"]);

    if (pulled.exitCode !== 0) throw new Error(`${pulled.stderr.toString()}\n${pulled.stdout.toString()}`);
    expect(runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString()).toEqual(runGit(publisher.host, ["rev-parse", "HEAD"]).stdout.toString());
    expect(() => lstatSync(join(subscriberHome, ".agents", "skills", "bar"))).toThrow();
    expect(lstatSync(join(subscriberHome, ".agents", "skills", "baz")).isSymbolicLink()).toBe(true);
    expect(stateAt(join(subscriber, ".local", "state.json")).disabledSkills).toEqual(["foo"]);
  });

  test("sync --dry-run previews the remote workflow without changing the catalog", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    attachRemote(f);

    const result = runCli(f.host, f.home, ["sync", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("already up to date");
    expect(runGit(f.host, ["status", "--porcelain"]).stdout.toString()).toBe("");
  });

  test("sync --dry-run projects a missing host lock without writing it", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    const lock = join(f.host, ".skill-lock.json");
    expect(existsSync(lock)).toBe(false);

    const result = runCli(f.host, f.home, ["sync", "--dry-run"]);

    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    expect(result.stdout.toString()).toContain("would verify and save catalog-managed changes");
    expect(existsSync(lock)).toBe(false);
  });

  test("sync previews and then restores all live vendor drift", () => {
    const f = fixture();
    addDriftingVendor(f);
    initializeGitFixture(f.host, f.home);
    attachRemote(f);
    const live = join(f.home, ".agents", "skills", "drifting", "SKILL.md");

    const preview = runCli(f.host, f.home, ["sync", "--dry-run"]);

    if (preview.exitCode !== 0) throw new Error(`${preview.stderr.toString()}\n${preview.stdout.toString()}`);
    expect(preview.stdout.toString()).toContain("would restore drifting live copy from repo baseline");
    expect(readFileSync(live, "utf8")).toBe("# live drifting\n");

    const synced = runCli(f.host, f.home, ["sync"]);

    if (synced.exitCode !== 0) throw new Error(`${synced.stderr.toString()}\n${synced.stdout.toString()}`);
    expect(synced.stdout.toString()).toContain("drifting: live copy restored from repo baseline");
    expect(readFileSync(live, "utf8")).toBe("# baseline drifting\n");
  }, 30_000);

  test("sync removes a disabled vendor after restoring its drift", () => {
    const f = fixture();
    addDriftingVendor(f);
    const state = JSON.parse(readFileSync(f.statePath, "utf8"));
    state.disabledSkills.push("drifting");
    writeFileSync(f.statePath, `${JSON.stringify(state)}\n`);
    const live = join(f.home, ".agents", "skills", "drifting");

    const synced = runCli(f.host, f.home, ["sync"]);

    if (synced.exitCode !== 0) throw new Error(`${synced.stderr.toString()}\n${synced.stdout.toString()}`);
    expect(existsSync(live)).toBe(false);
  });

  test("sync retires a locally removed catalog skill while saving", () => {
    const f = fixture();
    initializeGitFixture(f.host, f.home);
    expect(runCli(f.host, f.home, ["sync"], gitIdentity).exitCode).toBe(0);
    const live = join(f.home, ".agents", "skills", "bar");
    expect(lstatSync(live).isSymbolicLink()).toBe(true);
    const manifestPath = join(f.host, "skills.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.skills.bar;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    rmSync(join(f.host, "skills", "bar"), { recursive: true });

    const preview = runCli(f.host, f.home, ["sync", "--dry-run"]);
    if (preview.exitCode !== 0) throw new Error(`${preview.stderr.toString()}\n${preview.stdout.toString()}`);
    expect(preview.stdout.toString()).toContain("would remove-agents retired skill bar");
    expect(lstatSync(live).isSymbolicLink()).toBe(true);

    const synced = runCli(f.host, f.home, ["sync"], gitIdentity);
    if (synced.exitCode !== 0) throw new Error(`${synced.stderr.toString()}\n${synced.stdout.toString()}`);
    expect(existsSync(live)).toBe(false);
    expect(JSON.parse(readFileSync(f.statePath, "utf8")).disabledSkills).not.toContain("bar");
  });

  function divergedSubscriber(label: string) {
    const publisher = fixture();
    initializeGitFixture(publisher.host, publisher.home);
    const remote = attachRemote(publisher);
    const subscriber = join(publisher.root, `${label}-subscriber`);
    const subscriberHome = join(publisher.root, `${label}-home`);
    expect(Bun.spawnSync(["git", "clone", "-q", remote, subscriber]).exitCode).toBe(0);
    mkdirSync(join(subscriber, ".local"), { recursive: true });
    mkdirSync(subscriberHome, { recursive: true });
    return { publisher, subscriber, subscriberHome };
  }

  function commitFile(repo: string, name: string, body: string, message: string): void {
    writeFileSync(join(repo, name), body);
    expect(runGit(repo, ["add", name]).exitCode).toBe(0);
    expect(runGit(repo, ["commit", "-qm", message]).exitCode).toBe(0);
  }

  test("pull replays diverged local commits onto the upstream tip", () => {
    const { publisher, subscriber, subscriberHome } = divergedSubscriber("diverged");
    commitFile(publisher.host, "publisher-note.txt", "publisher\n", "Publisher commit");
    expect(runGit(publisher.host, ["push"]).exitCode).toBe(0);
    const publisherHead = runGit(publisher.host, ["rev-parse", "HEAD"]).stdout.toString().trim();
    commitFile(subscriber, "subscriber-note.txt", "subscriber\n", "Subscriber commit");

    const pulled = runCli(subscriber, subscriberHome, ["pull"]);

    if (pulled.exitCode !== 0) throw new Error(`${pulled.stderr.toString()}\n${pulled.stdout.toString()}`);
    expect(pulled.stdout.toString()).toContain("replaying 1 local commit(s)");
    // The local commit survives, on top of the upstream tip, with no merge commit.
    expect(runGit(subscriber, ["log", "-1", "--pretty=%s"]).stdout.toString().trim()).toBe("Subscriber commit");
    expect(runGit(subscriber, ["merge-base", "--is-ancestor", publisherHead, "HEAD"]).exitCode).toBe(0);
    expect(
      runGit(subscriber, ["rev-list", "--count", "--merges", `${publisherHead}..HEAD`])
        .stdout.toString()
        .trim(),
    ).toBe("0");
    expect(existsSync(join(subscriber, "publisher-note.txt"))).toBe(true);
    expect(existsSync(join(subscriber, "subscriber-note.txt"))).toBe(true);
    expect(runGit(subscriber, ["status", "--porcelain"]).stdout.toString().trim()).toBe("");
  }, 30_000);

  test("pull refuses to replay commits that do not merge cleanly", () => {
    const { publisher, subscriber, subscriberHome } = divergedSubscriber("conflicted");
    writeFileSync(join(publisher.host, "skills", "foo", "SKILL.md"), "# foo from publisher\n");
    expect(runCli(publisher.host, publisher.home, ["save"], gitIdentity).exitCode).toBe(0);
    expect(runGit(publisher.host, ["push"]).exitCode).toBe(0);
    writeFileSync(join(subscriber, "skills", "foo", "SKILL.md"), "# foo from subscriber\n");
    expect(runCli(subscriber, subscriberHome, ["save"], gitIdentity).exitCode).toBe(0);
    const before = runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString();

    const pulled = runCli(subscriber, subscriberHome, ["pull"]);

    expect(pulled.exitCode).toBe(1);
    expect(pulled.stderr.toString()).toContain("do not merge cleanly");
    expect(pulled.stderr.toString()).toContain("skills/foo/SKILL.md");
    expect(runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString()).toBe(before);
    expect(runGit(subscriber, ["status", "--porcelain"]).stdout.toString().trim()).toBe("");
  }, 30_000);

  test("pull refuses to replay commits when the merge retires a skill", () => {
    const { publisher, subscriber, subscriberHome } = divergedSubscriber("retiring");
    removeBarAndPublish(publisher);
    commitFile(subscriber, "subscriber-note.txt", "subscriber\n", "Subscriber commit");
    const before = runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString();

    const pulled = runCli(subscriber, subscriberHome, ["pull"]);

    expect(pulled.exitCode).toBe(1);
    expect(pulled.stderr.toString()).toContain("retires bar");
    expect(runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString()).toBe(before);
  }, 30_000);

  test("pull verifies a diverged merge before rewriting the branch", () => {
    const { publisher, subscriber, subscriberHome } = divergedSubscriber("invalid-merge");
    writeFileSync(join(publisher.host, "skills", "foo", "SKILL.md"), "# unverified publisher edit\n");
    expect(runGit(publisher.host, ["add", "skills/foo/SKILL.md"]).exitCode).toBe(0);
    expect(runGit(publisher.host, ["commit", "-qm", "Invalid publisher catalog"]).exitCode).toBe(0);
    expect(runGit(publisher.host, ["push"]).exitCode).toBe(0);
    commitFile(subscriber, "subscriber-note.txt", "subscriber\n", "Subscriber commit");
    const before = runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString();

    const pulled = runCli(subscriber, subscriberHome, ["pull"]);

    expect(pulled.exitCode).toBe(1);
    expect(pulled.stdout.toString()).toContain("hash mismatch");
    expect(runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString()).toBe(before);
    expect(runGit(subscriber, ["status", "--porcelain"]).stdout.toString().trim()).toBe("");
  }, 30_000);

  test("pull --dry-run reports a replay without touching the branch", () => {
    const { publisher, subscriber, subscriberHome } = divergedSubscriber("dry-diverged");
    commitFile(publisher.host, "publisher-note.txt", "publisher\n", "Publisher commit");
    expect(runGit(publisher.host, ["push"]).exitCode).toBe(0);
    commitFile(subscriber, "subscriber-note.txt", "subscriber\n", "Subscriber commit");
    const before = runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString();

    const pulled = runCli(subscriber, subscriberHome, ["pull", "--dry-run"]);

    expect(pulled.exitCode).toBe(0);
    expect(pulled.stdout.toString()).toContain("would replay 1 local commit(s)");
    expect(runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString()).toBe(before);
  }, 30_000);

  test("pull refuses a retired skill with a machine-local project link", () => {
    const publisher = fixture();
    initializeGitFixture(publisher.host, publisher.home);
    const remote = attachRemote(publisher);
    const subscriber = join(publisher.root, "linked-subscriber");
    const subscriberHome = join(publisher.root, "linked-home");
    const project = join(publisher.root, "linked-project");
    expect(Bun.spawnSync(["git", "clone", "-q", remote, subscriber]).exitCode).toBe(0);
    mkdirSync(join(subscriber, ".local"), { recursive: true });
    mkdirSync(subscriberHome, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(subscriber, ".local", "state.json"),
      `${JSON.stringify({
        version: 1,
        disabledSkills: [],
        activeProfile: null,
        projectLinks: [{ mode: "symlink", project, skill: "bar", targets: [".agents/skills/bar"], excludedTargets: [], linkedAt: "2026-08-18T00:00:00.000Z" }],
        recentProjects: [],
      })}\n`,
    );
    removeBarAndPublish(publisher);
    const before = runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString();

    const pulled = runCli(subscriber, subscriberHome, ["pull"]);

    expect(pulled.exitCode).toBe(1);
    expect(pulled.stderr.toString()).toContain("incoming catalog removes linked skills");
    expect(runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString()).toBe(before);
  });

  test("pull and sync refuse to retire a local skill replaced by a real directory", () => {
    const publisher = fixture();
    initializeGitFixture(publisher.host, publisher.home);
    const remote = attachRemote(publisher);
    const subscriber = join(publisher.root, "drift-subscriber");
    const subscriberHome = join(publisher.root, "drift-home");
    expect(Bun.spawnSync(["git", "clone", "-q", remote, subscriber]).exitCode).toBe(0);
    mkdirSync(subscriberHome, { recursive: true });
    expect(runCli(subscriber, subscriberHome, ["sync"]).exitCode).toBe(0);
    rmSync(join(subscriberHome, ".agents", "skills", "bar"));
    mkdirSync(join(subscriberHome, ".agents", "skills", "bar"));
    writeFileSync(join(subscriberHome, ".agents", "skills", "bar", "SKILL.md"), "# unrelated bar\n");
    removeBarAndPublish(publisher);
    const before = runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString();

    const pulled = runCli(subscriber, subscriberHome, ["pull"]);

    expect(pulled.exitCode).toBe(1);
    expect(pulled.stderr.toString()).toContain("live dir drifted from repo copy");
    expect(runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString()).toBe(before);
    expect(lstatSync(join(subscriberHome, ".claude", "skills", "bar")).isSymbolicLink()).toBe(true);

    const synced = runCli(subscriber, subscriberHome, ["sync"]);
    expect(synced.exitCode).toBe(1);
    expect(synced.stderr.toString()).toContain("live dir drifted from repo copy");
    expect(readFileSync(join(subscriberHome, ".agents", "skills", "bar", "SKILL.md"), "utf8")).toBe("# unrelated bar\n");
  }, 30_000);

  test("sync authorizes retiring a drifting vendor while pulling", () => {
    const publisher = fixture();
    addDriftingVendor(publisher);
    initializeGitFixture(publisher.host, publisher.home);
    const remote = attachRemote(publisher);
    const subscriber = join(publisher.root, "sync-drift-subscriber");
    const subscriberHome = join(publisher.root, "sync-drift-home");
    expect(Bun.spawnSync(["git", "clone", "-q", remote, subscriber]).exitCode).toBe(0);
    mkdirSync(subscriberHome, { recursive: true });
    const live = join(subscriberHome, ".agents", "skills", "drifting");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "SKILL.md"), "# unrelated drifting vendor\n");
    const manifest = JSON.parse(readFileSync(join(publisher.host, "skills.manifest.json"), "utf8"));
    delete manifest.skills.drifting;
    writeFileSync(join(publisher.host, "skills.manifest.json"), `${JSON.stringify(manifest)}\n`);
    rmSync(join(publisher.host, "vendor", "acme", "drifting"), { recursive: true });
    expect(runCli(publisher.host, publisher.home, ["save"], gitIdentity).exitCode).toBe(0);
    expect(runGit(publisher.host, ["push"]).exitCode).toBe(0);

    const synced = runCli(subscriber, subscriberHome, ["sync"]);

    if (synced.exitCode !== 0) throw new Error(`${synced.stderr.toString()}\n${synced.stdout.toString()}`);
    expect(existsSync(live)).toBe(false);
    expect(runGit(subscriber, ["rev-parse", "HEAD"]).stdout.toString()).toBe(runGit(publisher.host, ["rev-parse", "HEAD"]).stdout.toString());
  }, 30_000);
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

  test("restore all resets every drifting live vendor to the catalog baseline", () => {
    const f = fixture(["second"]);
    addDriftingVendor(f, "first");
    addDriftingVendor(f, "second");

    const result = runCli(f.host, f.home, ["restore", "all"]);

    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    expect(readFileSync(join(f.home, ".agents", "skills", "first", "SKILL.md"), "utf8")).toBe("# baseline first\n");
    expect(readFileSync(join(f.home, ".agents", "skills", "second", "SKILL.md"), "utf8")).toBe("# baseline second\n");
    expect(result.stdout.toString()).toContain("first: live copy restored from repo baseline");
    expect(result.stdout.toString()).toContain("second: live copy restored from repo baseline");
  });

  test("restore leaves the live copy intact when the catalog baseline is missing", () => {
    const f = fixture();
    addDriftingVendor(f);
    rmSync(join(f.host, "vendor", "acme", "drifting"), { recursive: true });

    const result = runCli(f.host, f.home, ["restore", "drifting"]);

    expect(result.exitCode).toBe(1);
    expect(readFileSync(join(f.home, ".agents", "skills", "drifting", "SKILL.md"), "utf8")).toBe("# live drifting\n");
  });

  test("adopt all imports every unindexed global skill", () => {
    const f = fixture();
    for (const name of ["first", "second"]) {
      mkdirSync(join(f.home, ".agents", "skills", name), { recursive: true });
      writeFileSync(join(f.home, ".agents", "skills", name, "SKILL.md"), `# ${name}\n`);
    }

    const result = runCli(f.host, f.home, ["adopt", "all"]);
    const manifest = decodeEncodedManifest(JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8")));

    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    expect(manifest.skills.first?.path).toBe("vendor/_unknown/first");
    expect(manifest.skills.second?.path).toBe("vendor/_unknown/second");
  });

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
    expect(realpathSync(readFileSync(join(f.home, "npx-cwd"), "utf8").trim())).toBe(realpathSync(f.host));
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
    const hostLock = JSON.parse(readFileSync(join(f.host, ".skill-lock.json"), "utf8"));
    expect(hostLock.skills.effect).toMatchObject({ source: "kitlangton/skills", sourceType: "github" });
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
    expect(Object.keys(JSON.parse(readFileSync(join(f.host, ".skill-lock.json"), "utf8")).skills)).toEqual(["cause", "effect"]);
  });

  test("adopts only global skills installed by the interactive add flow", () => {
    const f = fixture();
    const bin = join(f.root, "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(f.home, ".agents", "skills", "preexisting"), { recursive: true });
    writeFileSync(join(f.home, ".agents", "skills", "preexisting", "SKILL.md"), "# preexisting\n");
    const lock = JSON.stringify({
      version: 1,
      skills: Object.fromEntries(["arena", "unslop"].map((name) => [name, { source: "cursor/plugins", sourceType: "github", computedHash: "c".repeat(64) }])),
    });
    writeFileSync(
      join(bin, "npx"),
      `#!/bin/sh
mkdir -p "$HOME/.agents/skills/arena" "$HOME/.agents/skills/unslop"
printf '%s\n' '# arena' > "$HOME/.agents/skills/arena/SKILL.md"
printf '%s\n' '# unslop' > "$HOME/.agents/skills/unslop/SKILL.md"
printf '%s\n' '${lock}' > "$HOME/.agents/.skill-lock.json"
`,
    );
    chmodSync(join(bin, "npx"), 0o755);

    const result = runCli(f.host, f.home, ["skills", "add", "cursor/plugins"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    const manifest = decodeEncodedManifest(JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8")));

    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    expect(manifest.skills.arena?.path).toBe("vendor/cursor/arena");
    expect(manifest.skills.unslop?.path).toBe("vendor/cursor/unslop");
    expect(manifest.skills.preexisting).toBeUndefined();
    expect(existsSync(join(f.home, ".agents", "skills", "arena"))).toBe(true);
    expect(existsSync(join(f.home, ".agents", "skills", "unslop"))).toBe(true);
  });

  test("adopt absorbs global skills.sh provenance into the host lock", () => {
    const f = fixture();
    mkdirSync(join(f.home, ".agents", "skills", "effect"), { recursive: true });
    writeFileSync(join(f.home, ".agents", "skills", "effect", "SKILL.md"), "# effect\n");
    writeFileSync(
      join(f.home, ".agents", ".skill-lock.json"),
      `${JSON.stringify({
        version: 3,
        skills: {
          effect: {
            source: "kitlangton/skills",
            sourceType: "github",
            sourceUrl: "https://github.com/kitlangton/skills.git",
            skillPath: "skills/effect/SKILL.md",
            skillFolderHash: "a".repeat(40),
            ref: "main",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      })}\n`,
    );

    const result = runCli(f.host, f.home, ["adopt", "effect"]);

    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    const hostLock = JSON.parse(readFileSync(join(f.host, ".skill-lock.json"), "utf8"));
    expect(hostLock.skills.effect).toMatchObject({
      source: "kitlangton/skills",
      sourceType: "github",
      skillPath: "skills/effect/SKILL.md",
      skillFolderHash: "a".repeat(40),
      ref: "main",
    });
  });

  /** A vendor skill with committed provenance, ready for `slinky update`. */
  function addUpdatableVendor(f: ReturnType<typeof fixture>, name: string): void {
    const baseline = join(f.host, "vendor", "kitlangton", name);
    const live = join(f.home, ".agents", "skills", name);
    mkdirSync(baseline, { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(join(baseline, "SKILL.md"), `# ${name}\n`);
    writeFileSync(join(live, "SKILL.md"), `# ${name}\n`);
    const manifest = JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8"));
    manifest.skills[name] = {
      origin: "vendor",
      path: `vendor/kitlangton/${name}`,
      contentHash: contentHash(baseline),
      upstream: {
        kind: "github",
        repository: "kitlangton/skills",
        url: "https://github.com/kitlangton/skills.git",
        tracking: { kind: "tree", path: `skills/${name}/SKILL.md`, hash: "a".repeat(40) },
      },
      vendoredAt: null,
    };
    writeFileSync(join(f.host, "skills.manifest.json"), `${JSON.stringify(manifest)}\n`);
    const lockPath = join(f.host, ".skill-lock.json");
    const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : { version: 3, skills: {} };
    lock.skills[name] = {
      source: "kitlangton/skills",
      sourceType: "github",
      sourceUrl: "https://github.com/kitlangton/skills.git",
      skillPath: `skills/${name}/SKILL.md`,
      skillFolderHash: "a".repeat(40),
    };
    writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);
  }

  test("update reviews every changed skill in one pager session", () => {
    const f = fixture();
    addUpdatableVendor(f, "alpha");
    addUpdatableVendor(f, "beta");
    initializeGitFixture(f.host, f.home);
    const pagerBin = recordingPager(f.root, "delta");
    const npxBin = join(f.root, "update-bin");
    mkdirSync(npxBin);
    // skills.sh "updates" both live copies; the vendored baselines stay put.
    writeFileSync(
      join(npxBin, "npx"),
      `#!/bin/sh
printf '%s\\n' '# alpha upstream' > "$HOME/.agents/skills/alpha/SKILL.md"
printf '%s\\n' '# beta upstream' > "$HOME/.agents/skills/beta/SKILL.md"
`,
    );
    chmodSync(join(npxBin, "npx"), 0o755);

    const result = runCli(f.host, f.home, ["update", "--delta"], { PATH: `${pagerBin}:${npxBin}:${process.env.PATH ?? ""}` });

    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    // One session, both skills in it.
    expect(readFileSync(join(f.home, "delta-invocations"), "utf8")).toBe("x");
    const input = readFileSync(join(f.home, "delta-input"), "utf8");
    expect(input).toContain("-# alpha");
    expect(input).toContain("+# alpha upstream");
    expect(input).toContain("-# beta");
    expect(input).toContain("+# beta upstream");
    expect(result.stdout.toString()).toContain("reviewing 2 changed skill(s) in delta");
  });

  test("update seeds skills.sh from the committed host lock", () => {
    const f = fixture();
    const baseline = join(f.host, "vendor", "kitlangton", "effect");
    const live = join(f.home, ".agents", "skills", "effect");
    mkdirSync(baseline, { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(join(baseline, "SKILL.md"), "# effect\n");
    writeFileSync(join(live, "SKILL.md"), "# effect\n");
    const manifest = JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8"));
    manifest.skills.effect = {
      origin: "vendor",
      path: "vendor/kitlangton/effect",
      contentHash: contentHash(baseline),
      upstream: {
        kind: "github",
        repository: "kitlangton/skills",
        url: "https://github.com/kitlangton/skills.git",
        tracking: { kind: "tree", path: "skills/effect/SKILL.md", hash: "a".repeat(40) },
      },
      vendoredAt: null,
    };
    writeFileSync(join(f.host, "skills.manifest.json"), `${JSON.stringify(manifest)}\n`);
    writeFileSync(
      join(f.host, ".skill-lock.json"),
      `${JSON.stringify({
        version: 3,
        skills: {
          effect: {
            source: "kitlangton/skills",
            sourceType: "github",
            sourceUrl: "https://github.com/kitlangton/skills.git",
            skillPath: "skills/effect/SKILL.md",
            skillFolderHash: "a".repeat(40),
          },
        },
      })}\n`,
    );
    initializeGitFixture(f.host, f.home);
    writeFileSync(
      join(f.home, ".agents", ".skill-lock.json"),
      `${JSON.stringify({
        version: 3,
        skills: {
          effect: { source: "wrong/source", sourceType: "github" },
          foreign: { source: "/tmp/foreign", sourceType: "local" },
        },
        dismissed: { notice: true },
      })}\n`,
    );
    const bin = join(f.root, "update-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "npx"), '#!/bin/sh\ncp "$HOME/.agents/.skill-lock.json" "$HOME/seen-skill-lock.json"\n');
    chmodSync(join(bin, "npx"), 0o755);

    const result = runCli(f.host, f.home, ["update", "effect"], { PATH: `${bin}:${process.env.PATH ?? ""}` });

    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    const seen = JSON.parse(readFileSync(join(f.home, "seen-skill-lock.json"), "utf8"));
    expect(seen.skills.effect.source).toBe("kitlangton/skills");
    expect(seen.skills.foreign.sourceType).toBe("local");
    expect(seen.dismissed.notice).toBe(true);
    expect(result.stdout.toString()).toContain("no changes: all live copies still match the vendored baselines");
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
