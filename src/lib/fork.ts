import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Effect, Schema } from "effect";
import { alignStateWithManifest, errorDetail, formatUtc, getActiveProfile, getSkill, isSkillEnabled, nowUtc, OperationFailed, Skill, withManifestSkill } from "../domain/model.ts";
import type { ForkOrigin, Manifest } from "../domain/model.ts";
import { contentHash } from "./hash.ts";
import { ManifestStore } from "./manifest.ts";
import { HostRepo, Paths } from "./paths.ts";
import { reconcileCatalog } from "./reconcile.ts";

const decodeSkill = Schema.decodeUnknownSync(Skill);

/** A fork name must be a plain directory name: the manifest requires `skills/<name>` to end with it. */
const ForkName = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0") && value.trim() === value, {
    expected: "a skill name without path separators",
  }),
);
const isForkName = Schema.is(ForkName);

/** Default name for a fork: the vendor name with a `my-` prefix. */
export function defaultForkName(source: string): string {
  return `my-${source}`;
}

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const namePattern = /^(name:[ \t]*)(["']?)([^\r\n"']*)\2([ \t]*)$/m;

/**
 * Rewrite `name:` in SKILL.md frontmatter so the fork does not shadow its source.
 * Agents resolve skills by this field, not the directory; leaving it would make
 * two catalog entries claim the same skill. Everything else is preserved byte for byte.
 */
export function renameSkillFrontmatter(content: string, name: string): string {
  const match = frontmatterPattern.exec(content);
  if (!match) return content;
  const frontmatter = match[1]!;
  if (!namePattern.test(frontmatter)) return content;
  const renamed = frontmatter.replace(namePattern, (_, key: string, quote: string, __, trailing: string) => `${key}${quote}${name}${quote}${trailing}`);
  const start = match.index + match[0].indexOf(frontmatter);
  return content.slice(0, start) + renamed + content.slice(start + frontmatter.length);
}

export interface ForkOptions {
  /** Destination skill name; defaults to `my-<source>`. */
  readonly name?: string;
  readonly dryRun?: boolean;
  /** Fork the committed baseline even when the live global copy has drifted from it. */
  readonly force?: boolean;
}

export interface ForkResult {
  readonly name: string;
  /** Repo-relative destination, `skills/<name>`. */
  readonly path: string;
  readonly messages: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly dryRun: boolean;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function liveMatchesBaseline(live: string, baselineHash: string): boolean {
  try {
    const stat = lstatSync(live);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
  } catch {
    return true;
  }
  return contentHash(live) === baselineHash;
}

/**
 * Copy a vendor baseline into `skills/<name>` as a locally-authored skill,
 * index it with `forkedFrom` provenance, persist, and reconcile so the new
 * symlink appears in the global stores. The vendor entry is left untouched.
 */
export const forkSkill = Effect.fn("Fork.forkSkill")(function* (source: string, options: ForkOptions = {}) {
  const store = yield* ManifestStore;
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;
  const manifest = yield* store.loadManifest();
  const state = yield* store.loadState(manifest);

  const meta = getSkill(manifest, source);
  if (!meta) return yield* Effect.fail(new OperationFailed({ message: `unknown skill: ${source}` }));
  if (meta.origin !== "vendor") return yield* Effect.fail(new OperationFailed({ message: `${source} is a local skill; fork only applies to vendor skills` }));

  const name = options.name ?? defaultForkName(source);
  if (!isForkName(name)) return yield* Effect.fail(new OperationFailed({ message: `${JSON.stringify(name)} is not a valid skill name` }));
  if (getSkill(manifest, name)) return yield* Effect.fail(new OperationFailed({ message: `${name} is already indexed in skills.manifest.json` }));

  const rel = posix.join("skills", name);
  const dest = join(repo, rel);
  if (pathExists(dest)) return yield* Effect.fail(new OperationFailed({ message: `destination already exists: ${rel}` }));

  const baseline = join(repo, meta.path);
  if (!existsSync(baseline)) return yield* Effect.fail(new OperationFailed({ message: `${source}: repo copy missing at ${meta.path}` }));
  const baselineHash = contentHash(baseline);
  if (baselineHash !== meta.contentHash) {
    return yield* Effect.fail(new OperationFailed({ message: `${source}: committed baseline does not match its manifest hash; run \`slinky verify\`` }));
  }

  const warnings: string[] = [];
  const drifted = !liveMatchesBaseline(join(paths.agentsSkills, source), meta.contentHash);
  if (drifted && !options.force) {
    return yield* Effect.fail(
      new OperationFailed({
        message: `${source}: live copy differs from the vendor baseline; run \`slinky diff ${source}\` and vendor or restore it first (--force forks the baseline anyway)`,
      }),
    );
  }
  if (drifted) warnings.push(`${source}: live copy differs from the vendor baseline; forked the committed baseline`);

  if (options.dryRun) {
    return { name, path: rel, messages: [`copy ${meta.path} -> ${rel}`, `index ${name} as local (forked from ${source})`], warnings, dryRun: true } satisfies ForkResult;
  }

  // Copy through a sibling staging dir so a half-written fork never sits at the destination.
  const parent = join(repo, "skills");
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".slinky-fork-"));
  const prepared = join(staging, name);
  yield* Effect.try({
    try: () => {
      cpSync(baseline, prepared, { recursive: true });
      const skillFile = join(prepared, "SKILL.md");
      if (existsSync(skillFile)) writeFileSync(skillFile, renameSkillFrontmatter(readFileSync(skillFile, "utf8"), name));
      if (pathExists(dest)) throw new OperationFailed({ message: `destination already exists: ${rel}` });
      renameSync(prepared, dest);
    },
    catch: (error) => (error instanceof OperationFailed ? error : new OperationFailed({ message: `${name}: could not copy ${meta.path}: ${errorDetail(error)}` })),
  }).pipe(Effect.ensuring(Effect.sync(() => rmSync(staging, { recursive: true, force: true }))));

  const forkedFrom: ForkOrigin = { skill: source, upstream: meta.upstream, contentHash: meta.contentHash, forkedAt: nowUtc() };
  const forkHash = contentHash(dest);
  const skill = decodeSkill({ origin: "local", path: rel, contentHash: forkHash, forkedFrom: { ...forkedFrom, forkedAt: formatUtc(forkedFrom.forkedAt) } });
  const nextManifest: Manifest = withManifestSkill(manifest, name, skill);
  const nextState = alignStateWithManifest(nextManifest, state);

  yield* store.saveManifest(nextManifest).pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        if (pathExists(dest) && contentHash(dest) === forkHash) rmSync(dest, { recursive: true, force: true });
      }),
    ),
  );

  const { plan, applied } = yield* reconcileCatalog(nextManifest, nextState, {});
  warnings.push(...plan.warnings, ...(applied?.skipped ?? []));
  if (!isSkillEnabled(nextManifest, nextState, name)) {
    const profile = getActiveProfile(nextManifest, nextState);
    warnings.push(`${name}: not in the active profile ${profile}; add it to the profile or run \`slinky enable ${name}\``);
  }

  return { name, path: rel, messages: applied?.done ?? [], warnings, dryRun: false } satisfies ForkResult;
});
