import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Effect, Schema } from "effect";
import { errorDetail, formatUtc, HttpUrl, isMissingFile, OperationFailed, PortableRelativePath, SkillLockDecodeError, UpstreamTreeHash } from "../domain/model.ts";
import type { Manifest, Skill } from "../domain/model.ts";
import { HostRepo, Paths } from "./paths.ts";

export const skillLockVersion = 3;

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
  version: Schema.Number,
  skills: Schema.Record(Schema.String, LockMetaSchema),
});
export type SkillLockInput = typeof SkillLockFile.Encoded;

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const decodeJsonObject = Schema.decodeUnknownSync(JsonObject);
const isJsonObject = Schema.is(JsonObject);
const decodeLockMeta = Schema.decodeUnknownSync(LockMetaSchema);
const decodeSkillLockFile = Schema.decodeUnknownSync(SkillLockFile);

export interface SkillLockEntry {
  readonly [key: string]: Schema.Json;
}

interface MutableSkillLockEntry {
  [key: string]: Schema.Json;
}

export interface SkillLockSnapshot {
  readonly exists: boolean;
  readonly version: number;
  readonly root: SkillLockEntry;
  readonly entries: Readonly<Record<string, SkillLockEntry>>;
  readonly skills: Readonly<Record<string, LockMeta>>;
  readonly raw?: string;
  readonly warning?: SkillLockDecodeError;
}

const emptySnapshot = (exists = false): SkillLockSnapshot => ({
  exists,
  version: skillLockVersion,
  root: { version: skillLockVersion, skills: {} },
  entries: {},
  skills: {},
});

export function decodeSkillLock(input: SkillLockInput): Readonly<Record<string, LockMeta>> {
  return decodeSkillLockFile(input).skills;
}

export function readSkillLockFile(path: string): SkillLockSnapshot {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return isMissingFile(error) ? emptySnapshot() : { ...emptySnapshot(), warning: new SkillLockDecodeError(path, "read", errorDetail(error)) };
  }

  let root: SkillLockEntry;
  try {
    root = decodeJsonObject(JSON.parse(raw));
  } catch (error) {
    return { ...emptySnapshot(true), raw, warning: new SkillLockDecodeError(path, "parse", errorDetail(error)) };
  }

  try {
    const version = Schema.decodeUnknownSync(Schema.Number)(root.version);
    const rawSkills = decodeJsonObject(root.skills);
    const entries: Record<string, SkillLockEntry> = {};
    const skills: Record<string, LockMeta> = {};
    for (const [name, value] of Object.entries(rawSkills)) {
      if (!isJsonObject(value)) throw new Error(`${name}: expected lock entry object`);
      entries[name] = value;
      try {
        skills[name] = decodeLockMeta(value);
      } catch {
        // Preserve unrelated skills.sh providers even though Slinky cannot vendor them.
      }
    }
    return { exists: true, version, root, entries, skills, raw };
  } catch (error) {
    return { ...emptySnapshot(true), root, raw, warning: new SkillLockDecodeError(path, "decode", errorDetail(error)) };
  }
}

const EXTRA_ENTRY_FIELDS = ["ref", "pluginName", "sourceBaseUrl", "wellKnownDigest", "subagents"] as const;

/** Normalize a skills.sh entry while retaining fields needed by richer providers. */
export function canonicalLockEntry(meta: LockMeta, raw: SkillLockEntry | undefined, timestamp?: string | null): SkillLockEntry {
  const entry: MutableSkillLockEntry = {
    source: meta.source,
    sourceType: meta.sourceType,
  };
  if (meta.sourceUrl !== undefined) entry.sourceUrl = meta.sourceUrl;
  if (meta.sourceType === "github") {
    if (meta.skillPath !== undefined) entry.skillPath = meta.skillPath;
    if (meta.skillFolderHash !== undefined) entry.skillFolderHash = meta.skillFolderHash;
  } else if (meta.skillFolderHash !== undefined) {
    entry.skillFolderHash = meta.skillFolderHash;
  }
  for (const field of EXTRA_ENTRY_FIELDS) {
    const value = raw?.[field];
    if (value !== undefined) entry[field] = value;
  }
  const installedAt = raw?.installedAt ?? timestamp ?? undefined;
  const updatedAt = raw?.updatedAt ?? timestamp ?? undefined;
  if (installedAt !== undefined) entry.installedAt = installedAt;
  if (updatedAt !== undefined) entry.updatedAt = updatedAt;
  return entry;
}

type VendorSkill = Extract<Skill, { readonly origin: "vendor" }>;

export function upstreamFromLock(lock: LockMeta | undefined): VendorSkill["upstream"] {
  if (!lock) return { kind: "unknown", note: "adopted from host; upstream source unknown" };
  const url = lock.sourceUrl ?? null;
  if (lock.sourceType === "well-known") return { kind: "well-known", source: lock.source, url };
  const tracking = lock.skillPath && lock.skillFolderHash ? ({ kind: "tree", path: lock.skillPath, hash: lock.skillFolderHash } as const) : ({ kind: "untracked" } as const);
  return { kind: "github", repository: lock.source, url, tracking };
}

function sourceMatches(entry: SkillLockEntry, skill: VendorSkill): boolean {
  try {
    const meta = decodeLockMeta(entry);
    if (skill.upstream.kind === "unknown") return false;
    if (skill.upstream.kind === "well-known") {
      return meta.sourceType === "well-known" && meta.source === skill.upstream.source && (skill.upstream.url === null || meta.sourceUrl === skill.upstream.url);
    }
    return (
      meta.sourceType === "github" &&
      meta.source === skill.upstream.repository &&
      (skill.upstream.url === null || meta.sourceUrl === skill.upstream.url) &&
      (skill.upstream.tracking.kind === "untracked" || meta.skillPath === skill.upstream.tracking.path)
    );
  } catch {
    return false;
  }
}

function exactlyMatches(entry: SkillLockEntry, skill: VendorSkill): boolean {
  if (!sourceMatches(entry, skill)) return false;
  if (skill.upstream.kind !== "github" || skill.upstream.tracking.kind !== "tree") return true;
  const meta = decodeLockMeta(entry);
  return meta.sourceType === "github" && meta.skillFolderHash === skill.upstream.tracking.hash;
}

function entryFromSkill(skill: VendorSkill, globalEntry: SkillLockEntry | undefined): SkillLockEntry | undefined {
  const upstream = skill.upstream;
  if (upstream.kind === "unknown") return undefined;
  if (globalEntry && sourceMatches(globalEntry, skill) && (upstream.kind === "well-known" || (upstream.kind === "github" && upstream.tracking.kind === "untracked"))) {
    return canonicalLockEntry(decodeLockMeta(globalEntry), globalEntry, skill.vendoredAt === null ? undefined : formatUtc(skill.vendoredAt));
  }
  let meta: LockMeta;
  if (upstream.kind === "well-known") {
    meta = upstream.url === null ? { source: upstream.source, sourceType: "well-known" } : { source: upstream.source, sourceType: "well-known", sourceUrl: upstream.url };
  } else if (upstream.tracking.kind === "tree") {
    meta = {
      source: upstream.repository,
      sourceType: "github",
      skillPath: upstream.tracking.path,
      skillFolderHash: upstream.tracking.hash,
    };
    if (upstream.url !== null) meta = { ...meta, sourceUrl: upstream.url };
  } else {
    meta = { source: upstream.repository, sourceType: "github" };
    if (upstream.url !== null) meta = { ...meta, sourceUrl: upstream.url };
  }
  const timestamp = skill.vendoredAt === null ? undefined : formatUtc(skill.vendoredAt);
  return canonicalLockEntry(meta, globalEntry && sourceMatches(globalEntry, skill) ? globalEntry : undefined, timestamp);
}

function sortedEntries(entries: Readonly<Record<string, SkillLockEntry>>): Record<string, SkillLockEntry> {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

function writeRawLockFile(path: string, raw: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, raw);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw new SkillLockDecodeError(path, "write", errorDetail(error));
  }
}

function writeLockFile(path: string, root: SkillLockEntry): void {
  writeRawLockFile(path, `${JSON.stringify(root, null, 2)}\n`);
}

function restoreSkillLockFile(path: string, snapshot: SkillLockSnapshot): void {
  if (!snapshot.exists) {
    rmSync(path, { force: true });
    return;
  }
  writeRawLockFile(path, snapshot.raw ?? `${JSON.stringify(snapshot.root, null, 2)}\n`);
}

export const loadHostSkillLock = Effect.fn("SkillLock.loadHost")(function* () {
  const { catalogLock } = yield* HostRepo;
  return yield* loadSkillLockFile(catalogLock);
});

export const loadSkillLockFile = Effect.fn("SkillLock.loadFile")(function* (path: string) {
  const snapshot = readSkillLockFile(path);
  if (snapshot.warning) return yield* Effect.fail(snapshot.warning);
  if (Object.keys(snapshot.entries).length !== Object.keys(snapshot.skills).length) {
    return yield* Effect.fail(new SkillLockDecodeError(path, "decode", "host lock contains an unsupported or malformed vendor entry"));
  }
  if (snapshot.exists && snapshot.version !== skillLockVersion) {
    const relation = snapshot.version < skillLockVersion ? "older" : "newer";
    return yield* Effect.fail(new SkillLockDecodeError(path, "decode", `lock version ${snapshot.version} is ${relation} than supported version ${skillLockVersion}`));
  }
  return snapshot;
});

export const saveHostSkillLock = Effect.fn("SkillLock.saveHost")(function* (entries: Readonly<Record<string, SkillLockEntry>>) {
  const { catalogLock } = yield* HostRepo;
  yield* Effect.try({
    try: () => writeLockFile(catalogLock, { version: skillLockVersion, skills: sortedEntries(entries) }),
    catch: (error) => (error instanceof SkillLockDecodeError ? error : new SkillLockDecodeError(catalogLock, "write", errorDetail(error))),
  });
});

export const restoreHostSkillLock = Effect.fn("SkillLock.restoreHost")(function* (snapshot: SkillLockSnapshot) {
  const { catalogLock } = yield* HostRepo;
  yield* Effect.try({
    try: () => restoreSkillLockFile(catalogLock, snapshot),
    catch: (error) => (error instanceof SkillLockDecodeError ? error : new SkillLockDecodeError(catalogLock, "write", errorDetail(error))),
  });
});

export const restoreGlobalSkillLock = Effect.fn("SkillLock.restoreGlobal")(function* (snapshot: SkillLockSnapshot) {
  const paths = yield* Paths;
  yield* Effect.try({
    try: () => restoreSkillLockFile(paths.skillLock, snapshot),
    catch: (error) => (error instanceof SkillLockDecodeError ? error : new SkillLockDecodeError(paths.skillLock, "write", errorDetail(error))),
  });
});

/** Project the committed host lock after filling entries from manifest and machine authority. */
export const previewHostSkillLock = Effect.fn("SkillLock.previewHost")(function* (manifest: Manifest) {
  const host = yield* loadHostSkillLock();
  const paths = yield* Paths;
  const global = readSkillLockFile(paths.skillLock);
  const next: Record<string, SkillLockEntry> = {};

  for (const [name, skill] of Object.entries(manifest.skills)) {
    if (skill.origin !== "vendor" || skill.upstream.kind === "unknown") continue;
    const existing = host.entries[name];
    if (existing) {
      if (!exactlyMatches(existing, skill)) {
        return yield* Effect.fail(new OperationFailed({ message: `${name}: .skill-lock.json conflicts with skills.manifest.json` }));
      }
      next[name] = existing;
      continue;
    }
    const synthesized = entryFromSkill(skill, global.warning ? undefined : global.entries[name]);
    if (synthesized) next[name] = synthesized;
  }

  const encoded = JSON.stringify(sortedEntries(next));
  const changed = !host.exists || encoded !== JSON.stringify(sortedEntries(host.entries));
  const root = { version: skillLockVersion, skills: sortedEntries(next) };
  return {
    snapshot: { ...host, exists: true, version: skillLockVersion, root, entries: next, raw: `${JSON.stringify(root, null, 2)}\n` },
    changed,
  };
});

/** Create or complete the committed host lock from manifest authority. */
export const ensureHostSkillLock = Effect.fn("SkillLock.ensureHost")(function* (manifest: Manifest) {
  const projected = yield* previewHostSkillLock(manifest);
  if (projected.changed) yield* saveHostSkillLock(projected.snapshot.entries);
  return { entries: projected.snapshot.entries, changed: projected.changed };
});

export const validateHostSkillLock = Effect.fn("SkillLock.validateHost")(function* (manifest: Manifest) {
  const host = yield* loadHostSkillLock();
  return validateSkillLock(manifest, host);
});

export function validateSkillLock(manifest: Manifest, host: SkillLockSnapshot): string[] {
  const issues: string[] = [];
  for (const [name, skill] of Object.entries(manifest.skills)) {
    if (skill.origin !== "vendor" || skill.upstream.kind === "unknown") continue;
    const entry = host.entries[name];
    if (!entry) issues.push(`${name}: missing from .skill-lock.json`);
    else if (!exactlyMatches(entry, skill)) issues.push(`${name}: .skill-lock.json conflicts with manifest provenance`);
  }
  for (const name of Object.keys(host.entries)) {
    if (manifest.skills[name]?.origin !== "vendor") issues.push(`${name}: lock entry is not a manifest vendor skill`);
  }
  return issues;
}

function mergeGlobalRoot(snapshot: SkillLockSnapshot, entries: Readonly<Record<string, SkillLockEntry>>): SkillLockEntry {
  return {
    ...snapshot.root,
    version: skillLockVersion,
    skills: sortedEntries({ ...snapshot.entries, ...entries }),
  };
}

/** Make selected machine-global provenance exactly match the committed host lock. */
export const seedGlobalSkillLock = Effect.fn("SkillLock.seedGlobal")(function* (manifest: Manifest, names?: ReadonlyArray<string>) {
  const paths = yield* Paths;
  const host = yield* ensureHostSkillLock(manifest);
  const selected =
    names ??
    Object.entries(manifest.skills)
      .filter(([, skill]) => skill.origin === "vendor")
      .map(([name]) => name);
  const entries: Record<string, SkillLockEntry> = {};
  for (const name of selected) {
    const skill = manifest.skills[name];
    if (!skill || skill.origin !== "vendor") return yield* Effect.fail(new OperationFailed({ message: `${name}: not a vendor skill` }));
    const entry = host.entries[name];
    if (!entry) return yield* Effect.fail(new OperationFailed({ message: `${name}: no deterministic update provenance in .skill-lock.json` }));
    entries[name] = entry;
  }
  const global = readSkillLockFile(paths.skillLock);
  if (global.warning) return yield* Effect.fail(global.warning);
  if (global.exists && global.version !== skillLockVersion) {
    return yield* Effect.fail(new SkillLockDecodeError(paths.skillLock, "decode", `lock version ${global.version} is not supported for writes`));
  }
  yield* Effect.try({
    try: () => writeLockFile(paths.skillLock, mergeGlobalRoot(global, entries)),
    catch: (error) => (error instanceof SkillLockDecodeError ? error : new SkillLockDecodeError(paths.skillLock, "write", errorDetail(error))),
  });
});

/** Remove retired provenance only when the machine entry belongs to the old catalog skill. */
export const pruneGlobalSkillLockEntries = Effect.fn("SkillLock.pruneGlobal")(function* (
  manifest: Manifest,
  oldEntries: Readonly<Record<string, SkillLockEntry>>,
  names: ReadonlyArray<string>,
  force = false,
) {
  if (names.length === 0) return;
  const paths = yield* Paths;
  const global = readSkillLockFile(paths.skillLock);
  if (global.warning) return yield* Effect.fail(global.warning);
  if (global.exists && global.version !== skillLockVersion) {
    return yield* Effect.fail(new SkillLockDecodeError(paths.skillLock, "decode", `lock version ${global.version} is not supported for writes`));
  }
  const retired = new Set(names);
  const entries = Object.fromEntries(
    Object.entries(global.entries).filter(([name, entry]) => {
      if (!retired.has(name)) return true;
      const skill = manifest.skills[name];
      return !skill || skill.origin !== "vendor" || !(force ? sourceMatches(entry, skill) : isDeepStrictEqual(entry, oldEntries[name]));
    }),
  );
  if (Object.keys(entries).length === Object.keys(global.entries).length) return;
  yield* Effect.try({
    try: () => writeLockFile(paths.skillLock, { ...global.root, version: skillLockVersion, skills: sortedEntries(entries) }),
    catch: (error) => (error instanceof SkillLockDecodeError ? error : new SkillLockDecodeError(paths.skillLock, "write", errorDetail(error))),
  });
});

/** Copy selected, source-compatible global entries into the committed host lock. */
export const absorbGlobalSkillLockEntries = Effect.fn("SkillLock.absorbGlobal")(function* (manifest: Manifest, names: ReadonlyArray<string>, globalSnapshot?: SkillLockSnapshot) {
  if (names.length === 0) return;
  const paths = yield* Paths;
  const host = yield* loadHostSkillLock();
  const global = globalSnapshot ?? readSkillLockFile(paths.skillLock);
  if (global.warning) return yield* Effect.fail(global.warning);
  const next = { ...host.entries };
  for (const name of names) {
    const skill = manifest.skills[name];
    const entry = global.entries[name];
    if (!skill || skill.origin !== "vendor" || !entry || !sourceMatches(entry, skill)) {
      return yield* Effect.fail(new OperationFailed({ message: `${name}: updated global lock entry does not match the manifest source` }));
    }
    next[name] = canonicalLockEntry(decodeLockMeta(entry), entry, skill.vendoredAt === null ? undefined : formatUtc(skill.vendoredAt));
  }
  yield* saveHostSkillLock(next);
});
