import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import * as Schema from "effect/Schema";
import {
  Skill,
  SkillLockDecodeError,
  nowUtc,
  withManifestSkill,
} from "../domain/model.ts";
import type { Manifest } from "../domain/model.ts";
import { contentHash } from "./hash.ts";
import { AGENTS_SKILLS, CLAUDE_SKILLS, OPENCODE_SKILLS, REPO, SKILL_LOCK } from "./paths.ts";

const HttpUrl = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, { expected: "an HTTP or HTTPS URL" }),
);
const RepositoryRelativePath = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => {
    if (value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) return false;
    if (value === "." || posix.normalize(value) !== value) return false;
    return !value.split("/").includes("..");
  }, { expected: "a normalized repository-relative path" }),
);
const UpstreamTreeHash = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
);
const AdoptionDestination = Schema.Union([
  Schema.String.check(Schema.isPattern(/^skills\/[^/]+$/)),
  Schema.String.check(Schema.isPattern(/^vendor\/[^/]+\/[^/]+$/)),
]);
const decodeAdoptionDestination = Schema.decodeUnknownSync(AdoptionDestination);
const decodeSkill = Schema.decodeUnknownSync(Skill);

const LockMetaBase = {
  source: Schema.NonEmptyString,
  sourceUrl: Schema.optionalKey(HttpUrl),
};

const GitHubLockMetaSchema = Schema.Struct({
  ...LockMetaBase,
  sourceType: Schema.Literal("github"),
  skillPath: Schema.optionalKey(RepositoryRelativePath),
  skillFolderHash: Schema.optionalKey(UpstreamTreeHash),
});

const WellKnownLockMetaSchema = Schema.Struct({
  ...LockMetaBase,
  sourceType: Schema.Literal("well-known"),
  skillFolderHash: Schema.optionalKey(Schema.String),
});

const LockMetaSchema = Schema.Union([GitHubLockMetaSchema, WellKnownLockMetaSchema]);

export type LockMeta = typeof LockMetaSchema.Type;

const SkillLockFile = Schema.Struct({
  skills: Schema.Record(Schema.String, LockMetaSchema),
});

export interface SkillLockSnapshot {
  readonly skills: Readonly<Record<string, LockMeta>>;
  readonly warning?: SkillLockDecodeError;
}

const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export function decodeSkillLock(input: unknown): Readonly<Record<string, LockMeta>> {
  return Schema.decodeUnknownSync(SkillLockFile)(input).skills;
}

export function readSkillLock(): SkillLockSnapshot {
  let raw: string;
  try {
    raw = readFileSync(SKILL_LOCK, "utf8");
  } catch (error) {
    return isMissing(error)
      ? { skills: {} }
      : { skills: {}, warning: new SkillLockDecodeError(SKILL_LOCK, "read", detail(error)) };
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    return { skills: {}, warning: new SkillLockDecodeError(SKILL_LOCK, "parse", detail(error)) };
  }

  try {
    return { skills: decodeSkillLock(input) };
  } catch (error) {
    return { skills: {}, warning: new SkillLockDecodeError(SKILL_LOCK, "decode", detail(error)) };
  }
}

type VendorUpstream = Extract<Skill, { readonly origin: "vendor" }>["upstream"];

export function upstreamFromLock(lock: LockMeta | undefined): VendorUpstream {
  if (!lock) {
    return { kind: "unknown", note: "adopted from host; upstream source unknown" };
  }
  const url = lock.sourceUrl ?? null;
  if (lock.sourceType === "well-known") {
    return { kind: "well-known", source: lock.source, url };
  }
  const tracking =
    lock.skillPath && lock.skillFolderHash
      ? {
          kind: "tree",
          path: lock.skillPath,
          hash: lock.skillFolderHash,
        } as const
      : ({ kind: "untracked" } as const);
  return {
    kind: "github",
    repository: lock.source,
    url,
    tracking,
  };
}

export interface ForeignSkill {
  readonly name: string;
  /** Where the real dir lives. */
  readonly location: "agents" | "claude" | "opencode";
  readonly dir: string;
  /** Provenance from this host's skills.sh lock file, when tracked. */
  readonly lock?: LockMeta;
}

export interface ForeignScan {
  readonly candidates: ReadonlyArray<ForeignSkill>;
  readonly warning?: SkillLockDecodeError;
}

/**
 * Find skills present on this host but absent from the repo manifest.
 * Scans the canonical store first, then per-agent dirs; only real directories
 * containing a SKILL.md count (symlinks are managed entries or user business).
 */
export function findForeign(manifest: Manifest): ForeignScan {
  const lock = readSkillLock();
  const seen = new Set<string>();
  const out: ForeignSkill[] = [];
  const locations: Array<[ForeignSkill["location"], string]> = [
    ["agents", AGENTS_SKILLS],
    ["claude", CLAUDE_SKILLS],
    ["opencode", OPENCODE_SKILLS],
  ];
  for (const [location, base] of locations) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (Object.hasOwn(manifest.skills, name) || seen.has(name)) continue;
      const dir = join(base, name);
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, "SKILL.md"))) continue;
      seen.add(name);
      const meta = lock.skills[name];
      out.push({ name, location, dir, ...(meta ? { lock: meta } : {}) });
    }
  }
  return {
    candidates: out.sort((a, b) => a.name.localeCompare(b.name)),
    ...(lock.warning ? { warning: lock.warning } : {}),
  };
}

export interface AdoptOptions {
  /** Adopt as a locally-authored skill into skills/ instead of vendor/. */
  readonly local?: boolean;
  /** Vendor owner directory when provenance is unknown (default "_unknown"). */
  readonly owner?: string;
}

export interface Adoption {
  readonly manifest: Manifest;
  readonly meta: Skill;
  readonly destination: string;
  readonly sourceToRemove: string | null;
}

/** Repo-relative destination for an adopted skill. */
export function adoptDestination(candidate: ForeignSkill, opts: AdoptOptions): string {
  if (opts.local) return decodeAdoptionDestination(posix.join("skills", candidate.name));
  const owner =
    opts.owner ??
      (candidate.lock
        ? candidate.lock.sourceType === "github"
          ? candidate.lock.source.split("/")[0]!
          : candidate.lock.source
        : "_unknown");
  return decodeAdoptionDestination(posix.join("vendor", owner, candidate.name));
}

/** Copy a foreign skill into the repo and return an updated manifest. */
export function adoptSkill(
  manifest: Manifest,
  candidate: ForeignSkill,
  opts: AdoptOptions = {},
): Adoption {
  const rel = adoptDestination(candidate, opts);
  const dest = join(REPO, rel);
  if (existsSync(dest)) throw new Error(`destination already exists: ${rel}`);

  const meta = decodeSkill(
    opts.local
      ? { origin: "local", path: rel, contentHash: contentHash(candidate.dir) }
      : {
          origin: "vendor",
          path: rel,
          contentHash: contentHash(candidate.dir),
          upstream: upstreamFromLock(candidate.lock),
          vendoredAt: nowUtc(),
        },
  );

  try {
    cpSync(candidate.dir, dest, { recursive: true });

    const keepLiveDir = candidate.location === "agents" && !opts.local;
    return {
      manifest: withManifestSkill(manifest, candidate.name, meta),
      meta,
      destination: dest,
      sourceToRemove: keepLiveDir ? null : candidate.dir,
    };
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

export function rollbackAdoption(adoption: Adoption): void {
  rmSync(adoption.destination, { recursive: true, force: true });
}

export function finalizeAdoption(adoption: Adoption): void {
  if (adoption.sourceToRemove) {
    rmSync(adoption.sourceToRemove, { recursive: true, force: true });
  }
}
