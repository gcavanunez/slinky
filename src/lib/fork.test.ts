import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { ManifestFileError } from "../domain/model.ts";
import { contentHash } from "./hash.ts";
import { defaultForkName, forkSkill, renameSkillFrontmatter } from "./fork.ts";
import { ManifestStore } from "./manifest.ts";
import { HostRepo, Paths } from "./paths.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly host: string;
  readonly home: string;
  readonly baseline: string;
  readonly live: string;
}

const upstream = {
  kind: "github",
  repository: "acme/skills",
  url: "https://github.com/acme/skills",
  tracking: { kind: "tree", path: "skills/review/SKILL.md", hash: "b".repeat(40) },
} as const;

const skillBody = "---\nname: review\ndescription: Review code.\n---\n\n# Review\n\nBe thorough.\n";

/** A host with one vendor skill `review` whose live copy matches the baseline, plus a local `foo`. */
function fixture(options: { readonly selection?: unknown; readonly liveBody?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "slinky-fork-"));
  roots.push(root);
  const host = join(root, "host");
  const home = join(root, "home");
  const baseline = join(host, "vendor", "acme", "review");
  const live = join(home, ".agents", "skills", "review");
  mkdirSync(join(host, ".local"), { recursive: true });
  mkdirSync(join(host, "skills", "foo"), { recursive: true });
  writeFileSync(join(host, "skills", "foo", "SKILL.md"), "# foo\n");
  mkdirSync(baseline, { recursive: true });
  mkdirSync(join(baseline, "references"), { recursive: true });
  writeFileSync(join(baseline, "SKILL.md"), skillBody);
  writeFileSync(join(baseline, "references", "notes.md"), "notes\n");
  mkdirSync(live, { recursive: true });
  mkdirSync(join(live, "references"), { recursive: true });
  writeFileSync(join(live, "SKILL.md"), options.liveBody ?? skillBody);
  writeFileSync(join(live, "references", "notes.md"), "notes\n");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  writeFileSync(
    join(host, "skills.manifest.json"),
    `${JSON.stringify({
      version: 1,
      skills: {
        foo: { origin: "local", path: "skills/foo", contentHash: contentHash(join(host, "skills", "foo")) },
        review: { origin: "vendor", path: "vendor/acme/review", contentHash: contentHash(baseline), upstream, vendoredAt: "2026-07-13T12:00:00.000Z" },
      },
      profiles: { work: ["foo", "review"] },
    })}\n`,
  );
  writeFileSync(
    join(host, ".local", "state.json"),
    `${JSON.stringify({ version: 2, selection: options.selection ?? { kind: "custom", disabledSkills: [] }, projectLinks: [], recentProjects: [] })}\n`,
  );
  return { host, home, baseline, live };
}

const layerFor = (f: Fixture) =>
  ManifestStore.layer.pipe(
    Layer.provideMerge(HostRepo.layer),
    Layer.provideMerge(Paths.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: f.home, SLINKY_REPO: f.host }))),
  );

const run = <A, E>(f: Fixture, effect: Effect.Effect<A, E, ManifestStore | HostRepo | Paths>): Exit.Exit<A, unknown> =>
  Effect.runSyncExit(effect.pipe(Effect.provide(layerFor(f))));

const success = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got: ${Cause.squash(exit.cause)}`);
  return exit.value;
};

const failureMessage = <A>(exit: Exit.Exit<A, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const error = Cause.squash(exit.cause);
  return error instanceof Error ? error.message : String(error);
};

const manifestOf = (f: Fixture) => JSON.parse(readFileSync(join(f.host, "skills.manifest.json"), "utf8"));

describe("defaultForkName", () => {
  test("prefixes the vendor name", () => {
    expect(defaultForkName("review")).toBe("my-review");
  });
});

describe("renameSkillFrontmatter", () => {
  test("rewrites only the name field", () => {
    expect(renameSkillFrontmatter(skillBody, "my-review")).toBe("---\nname: my-review\ndescription: Review code.\n---\n\n# Review\n\nBe thorough.\n");
  });

  test("handles quoted names and CRLF", () => {
    expect(renameSkillFrontmatter('---\r\nname: "review"\r\ndescription: x\r\n---\r\nbody', "my-review")).toBe('---\r\nname: "my-review"\r\ndescription: x\r\n---\r\nbody');
  });

  test("leaves content without a name field untouched", () => {
    expect(renameSkillFrontmatter("---\ndescription: x\n---\nbody", "my-review")).toBe("---\ndescription: x\n---\nbody");
    expect(renameSkillFrontmatter("# no frontmatter\nname: not-frontmatter\n", "my-review")).toBe("# no frontmatter\nname: not-frontmatter\n");
  });
});

describe("forkSkill", () => {
  test("copies the vendor baseline into skills/, records provenance, and links it live", () => {
    const f = fixture();

    const result = success(run(f, forkSkill("review")));

    expect(result.name).toBe("my-review");
    expect(result.path).toBe("skills/my-review");
    expect(result.warnings).toEqual([]);

    const dest = join(f.host, "skills", "my-review");
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("---\nname: my-review\ndescription: Review code.\n---\n\n# Review\n\nBe thorough.\n");
    expect(readFileSync(join(dest, "references", "notes.md"), "utf8")).toBe("notes\n");

    const manifest = manifestOf(f);
    expect(manifest.skills["my-review"]).toEqual({
      origin: "local",
      path: "skills/my-review",
      contentHash: contentHash(dest),
      forkedFrom: { skill: "review", upstream, contentHash: contentHash(f.baseline), forkedAt: manifest.skills["my-review"].forkedFrom.forkedAt },
    });
    expect(manifest.skills.review.origin).toBe("vendor");
    expect(existsSync(f.baseline)).toBe(true);
    expect(readFileSync(join(f.live, "SKILL.md"), "utf8")).toBe(skillBody);

    const liveFork = join(f.home, ".agents", "skills", "my-review");
    expect(lstatSync(liveFork).isSymbolicLink()).toBe(true);
    expect(readlinkSync(liveFork)).toBe(dest);
    expect(lstatSync(join(f.home, ".claude", "skills", "my-review")).isSymbolicLink()).toBe(true);
    expect(result.messages.some((message) => message.includes("my-review"))).toBe(true);
  });

  test("honours an explicit name", () => {
    const f = fixture();

    const result = success(run(f, forkSkill("review", { name: "review-strict" })));

    expect(result.path).toBe("skills/review-strict");
    expect(readFileSync(join(f.host, "skills", "review-strict", "SKILL.md"), "utf8")).toContain("name: review-strict\n");
  });

  test("dry run reports the destination without touching anything", () => {
    const f = fixture();
    const before = readFileSync(join(f.host, "skills.manifest.json"), "utf8");

    const result = success(run(f, forkSkill("review", { dryRun: true })));

    expect(result.dryRun).toBe(true);
    expect(result.path).toBe("skills/my-review");
    expect(existsSync(join(f.host, "skills", "my-review"))).toBe(false);
    expect(readFileSync(join(f.host, "skills.manifest.json"), "utf8")).toBe(before);
  });

  test("rejects unknown, local, taken, and unsafe names", () => {
    const f = fixture();

    expect(failureMessage(run(f, forkSkill("nope")))).toBe("unknown skill: nope");
    expect(failureMessage(run(f, forkSkill("foo")))).toBe("foo is a local skill; fork only applies to vendor skills");
    expect(failureMessage(run(f, forkSkill("review", { name: "foo" })))).toBe("foo is already indexed in skills.manifest.json");
    expect(failureMessage(run(f, forkSkill("review", { name: "review" })))).toBe("review is already indexed in skills.manifest.json");
    expect(failureMessage(run(f, forkSkill("review", { name: "../escape" })))).toContain("not a valid skill name");
    expect(failureMessage(run(f, forkSkill("review", { name: "a/b" })))).toContain("not a valid skill name");
    expect(failureMessage(run(f, forkSkill("review", { name: "" })))).toContain("not a valid skill name");
  });

  test("refuses when the destination directory already exists on disk", () => {
    const f = fixture();
    mkdirSync(join(f.host, "skills", "my-review"), { recursive: true });

    expect(failureMessage(run(f, forkSkill("review")))).toBe("destination already exists: skills/my-review");
    expect(manifestOf(f).skills["my-review"]).toBeUndefined();
  });

  test("refuses live drift without force and forks the baseline with it", () => {
    const f = fixture({ liveBody: "---\nname: review\n---\nedited live\n" });

    expect(failureMessage(run(f, forkSkill("review")))).toBe(
      "review: live copy differs from the vendor baseline; run `slinky diff review` and vendor or restore it first (--force forks the baseline anyway)",
    );
    expect(existsSync(join(f.host, "skills", "my-review"))).toBe(false);

    const result = success(run(f, forkSkill("review", { force: true })));
    expect(result.warnings).toEqual(["review: live copy differs from the vendor baseline; forked the committed baseline"]);
    expect(readFileSync(join(f.host, "skills", "my-review", "SKILL.md"), "utf8")).toContain("Be thorough.");
  });

  test("with a profile active the fork is indexed but stays disabled", () => {
    const f = fixture({ selection: { kind: "profile", name: "work" } });

    const result = success(run(f, forkSkill("review")));

    expect(manifestOf(f).skills["my-review"].origin).toBe("local");
    expect(existsSync(join(f.home, ".agents", "skills", "my-review"))).toBe(false);
    expect(result.warnings).toEqual(["my-review: not in the active profile work; add it to the profile or run `slinky enable my-review`"]);
  });

  test("rolls the copy back when the manifest cannot be saved", () => {
    const f = fixture();
    const failingStore = Layer.effect(
      ManifestStore,
      Effect.gen(function* () {
        const real = yield* ManifestStore;
        return ManifestStore.of({ ...real, saveManifest: () => Effect.fail(new ManifestFileError(join(f.host, "skills.manifest.json"), "write", "disk full")) });
      }),
    ).pipe(Layer.provide(layerFor(f)), Layer.provideMerge(layerFor(f)));

    const exit = Effect.runSyncExit(forkSkill("review").pipe(Effect.provide(failingStore)));

    expect(failureMessage(exit)).toContain("disk full");
    expect(existsSync(join(f.host, "skills", "my-review"))).toBe(false);
    expect(existsSync(join(f.home, ".agents", "skills", "my-review"))).toBe(false);
  });
});
