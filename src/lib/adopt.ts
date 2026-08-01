import { cpSync, existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import { Effect, Schema } from "effect";
import {
  errorDetail,
  formatUtc,
  HttpUrl,
  isMissingFile,
  nowUtc,
  OperationFailed,
  PortableRelativePath,
  Skill,
  SkillLockDecodeError,
  UpstreamTreeHash,
  withManifestSkill,
} from "../domain/model.ts";
import type { Manifest } from "../domain/model.ts";
import { readdirIfExists } from "./fs.ts";
import { contentHash } from "./hash.ts";
import { HostRepo, Paths } from "./paths.ts";

const AdoptionDestination = Schema.Union([Schema.String.check(Schema.isPattern(/^skills\/[^/]+$/)), Schema.String.check(Schema.isPattern(/^vendor\/[^/]+\/[^/]+$/))]);
const decodeAdoptionDestination = Schema.decodeUnknownSync(AdoptionDestination);
const decodeSkill = Schema.decodeUnknownSync(Skill);

const LockMetaBase = {
  source: Schema.NonEmptyString,
  sourceUrl: Schema.optionalKey(HttpUrl),
};

const GitHubLockMetaSchema = Schema.Struct({
  ...LockMetaBase,
  sourceType: Schema.Literal("github"),
  skillPath: Schema.optionalKey(PortableRelativePath),
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

export function decodeSkillLock(input: unknown): Readonly<Record<string, LockMeta>> {
  return Schema.decodeUnknownSync(SkillLockFile)(input).skills;
}

function readSkillLockSync(skillLock: string): SkillLockSnapshot {
  let raw: string;
  try {
    raw = readFileSync(skillLock, "utf8");
  } catch (error) {
    return isMissingFile(error) ? { skills: {} } : { skills: {}, warning: new SkillLockDecodeError(skillLock, "read", errorDetail(error)) };
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    return { skills: {}, warning: new SkillLockDecodeError(skillLock, "parse", errorDetail(error)) };
  }

  try {
    return { skills: decodeSkillLock(input) };
  } catch (error) {
    return { skills: {}, warning: new SkillLockDecodeError(skillLock, "decode", errorDetail(error)) };
  }
}

/** Read the skills.sh lock file; decode problems degrade to a warning. */
export const readSkillLock = Effect.fn("Adopt.readSkillLock")(function* () {
  const paths = yield* Paths;
  return readSkillLockSync(paths.skillLock);
});

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
      ? ({
          kind: "tree",
          path: lock.skillPath,
          hash: lock.skillFolderHash,
        } as const)
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

export interface UnindexedSkill {
  readonly name: string;
  readonly origin: "local" | "vendor" | "agent";
  readonly path: string;
  readonly dir: string;
}

/** Find host skill directories that are absent from the manifest. */
export function findUnindexedSkills(manifest: Manifest, repo: string): UnindexedSkill[] {
  const indexed = new Set(Object.values(manifest.skills).map((skill) => skill.path));
  const out: UnindexedSkill[] = [];
  const add = (origin: UnindexedSkill["origin"], path: string, name: string, isIndexed = indexed.has(path)): void => {
    const dir = join(repo, path);
    if (!isIndexed && existsSync(join(dir, "SKILL.md"))) out.push({ name, origin, path, dir });
  };

  for (const entry of readdirIfExists(join(repo, "skills"))) {
    if (entry.isDirectory()) add("local", posix.join("skills", entry.name), entry.name);
  }

  for (const owner of readdirIfExists(join(repo, "vendor"))) {
    if (!owner.isDirectory()) continue;
    for (const entry of readdirIfExists(join(repo, "vendor", owner.name))) {
      if (entry.isDirectory()) add("vendor", posix.join("vendor", owner.name, entry.name), entry.name);
    }
  }

  for (const entry of readdirIfExists(join(repo, ".agents", "skills"))) {
    if (entry.isDirectory()) {
      add("agent", posix.join(".agents", "skills", entry.name), entry.name, Object.hasOwn(manifest.skills, entry.name));
    }
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Find skills present on this host but absent from the repo manifest.
 * Scans the canonical store first, then per-agent dirs; only real directories
 * containing a SKILL.md count (symlinks are managed entries or user business).
 */
export const findForeign = Effect.fn("Adopt.findForeign")(function* (manifest: Manifest) {
  const paths = yield* Paths;
  const lock = readSkillLockSync(paths.skillLock);
  const seen = new Set<string>();
  const out: ForeignSkill[] = [];
  const locations: Array<[ForeignSkill["location"], string]> = [
    ["agents", paths.agentsSkills],
    ["claude", paths.claudeSkills],
    ["opencode", paths.opencodeSkills],
  ];
  for (const [location, base] of locations) {
    for (const { name } of readdirIfExists(base)) {
      if (Object.hasOwn(manifest.skills, name) || seen.has(name)) continue;
      const dir = join(base, name);
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, "SKILL.md"))) continue;
      seen.add(name);
      const meta = lock.skills[name];
      out.push({ name, location, dir, ...(meta ? { lock: meta } : {}) });
    }
  }
  const scan: ForeignScan = {
    candidates: out.sort((a, b) => a.name.localeCompare(b.name)),
    ...(lock.warning ? { warning: lock.warning } : {}),
  };
  return scan;
});

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
  const owner = opts.owner ?? (candidate.lock ? (candidate.lock.sourceType === "github" ? candidate.lock.source.split("/")[0]! : candidate.lock.source) : "_unknown");
  return decodeAdoptionDestination(posix.join("vendor", owner, candidate.name));
}

/** Copy a foreign skill into the repo and return an updated manifest. */
export const adoptSkill = Effect.fn("Adopt.adoptSkill")(function* (manifest: Manifest, candidate: ForeignSkill, opts: AdoptOptions = {}) {
  const { repo } = yield* HostRepo;
  const rel = adoptDestination(candidate, opts);
  const dest = join(repo, rel);
  if (existsSync(dest)) {
    return yield* Effect.fail(new OperationFailed({ message: `destination already exists: ${rel}` }));
  }

  const meta = decodeSkill(
    opts.local
      ? { origin: "local", path: rel, contentHash: contentHash(candidate.dir) }
      : {
          origin: "vendor",
          path: rel,
          contentHash: contentHash(candidate.dir),
          upstream: upstreamFromLock(candidate.lock),
          vendoredAt: formatUtc(nowUtc()),
        },
  );

  return yield* Effect.sync(() => {
    cpSync(candidate.dir, dest, { recursive: true });
    const keepLiveDir = candidate.location === "agents" && !opts.local;
    return {
      manifest: withManifestSkill(manifest, candidate.name, meta),
      meta,
      destination: dest,
      sourceToRemove: keepLiveDir ? null : candidate.dir,
    } satisfies Adoption;
  }).pipe(Effect.onError(() => Effect.sync(() => rmSync(dest, { recursive: true, force: true }))));
});

export function rollbackAdoption(adoption: Adoption): void {
  rmSync(adoption.destination, { recursive: true, force: true });
}

export function finalizeAdoption(adoption: Adoption): void {
  if (adoption.sourceToRemove) {
    rmSync(adoption.sourceToRemove, { recursive: true, force: true });
  }
}
