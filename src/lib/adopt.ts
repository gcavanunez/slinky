import { cpSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Effect, Schema } from "effect";
import { errorDetail, formatUtc, isMissingFile, nowUtc, OperationFailed, Skill, withManifestSkill } from "../domain/model.ts";
import type { Manifest } from "../domain/model.ts";
import type { SkillLockDecodeError } from "../domain/model.ts";
import { readdirIfExists } from "./fs.ts";
import { contentHash } from "./hash.ts";
import { HostRepo, Paths } from "./paths.ts";
import { canonicalLockEntry, readSkillLockFile, upstreamFromLock } from "./skillLock.ts";
import type { LockMeta, SkillLockEntry } from "./skillLock.ts";
import { GitHub } from "./update.ts";

export { decodeSkillLock, upstreamFromLock } from "./skillLock.ts";
export type { LockMeta, SkillLockInput, SkillLockSnapshot } from "./skillLock.ts";

const AdoptionDestination = Schema.Union([Schema.String.check(Schema.isPattern(/^skills\/[^/]+$/)), Schema.String.check(Schema.isPattern(/^vendor\/[^/]+\/[^/]+$/))]);
const decodeAdoptionDestination = Schema.decodeUnknownSync(AdoptionDestination);
const decodeSkill = Schema.decodeUnknownSync(Skill);

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const decodeJsonObject = Schema.decodeUnknownSync(JsonObject);
const isJsonObject = Schema.is(JsonObject);

/** Read the skills.sh lock file; decode problems degrade to a warning. */
export const readSkillLock = Effect.fn("Adopt.readSkillLock")(function* () {
  const paths = yield* Paths;
  return readSkillLockFile(paths.skillLock);
});

export interface ForeignSkill {
  readonly name: string;
  /** Where the real dir lives. `staged` is the repo's own .agents/skills inbox. */
  readonly location: "agents" | "claude" | "opencode" | "staged";
  readonly dir: string;
  /** Provenance from a skills.sh lock file, when tracked. */
  readonly lock?: LockMeta;
  /** Full entry retained for the committed host lock. */
  readonly lockEntry?: SkillLockEntry;
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
  const lock = readSkillLockFile(paths.skillLock);
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
      const entry = lock.entries[name];
      const candidate: ForeignSkill = meta === undefined || entry === undefined ? { name, location, dir } : { name, location, dir, lock: meta, lockEntry: entry };
      out.push(candidate);
    }
  }
  const candidates = out.sort((a, b) => a.name.localeCompare(b.name));
  const scan: ForeignScan = lock.warning === undefined ? { candidates } : { candidates, warning: lock.warning };
  return scan;
});

// --- staging area -----------------------------------------------------------
//
// `npx skills add` run inside the host repo installs into <repo>/.agents/skills
// and records provenance in <repo>/skills-lock.json. skills.sh cannot be pointed
// at vendor/<owner>/<name> (its install dir is a hardcoded constant), so that
// inbox is the only handoff point it offers. Slinky consolidates from there.

/** Why a staged directory can or cannot be adopted. */
export type StagedStatus =
  /** Not in the manifest: adopt it. */
  | { readonly kind: "new" }
  /** Already indexed and byte-identical to the baseline: the staging copy is redundant. */
  | { readonly kind: "duplicate"; readonly path: string }
  /** Already indexed but the content moved on: that is an update, not an adoption. */
  | { readonly kind: "changed"; readonly path: string };

export interface StagedSkill {
  readonly candidate: ForeignSkill;
  readonly status: StagedStatus;
}

export interface StagedScan {
  readonly staged: ReadonlyArray<StagedSkill>;
  readonly warning?: SkillLockDecodeError;
}

/**
 * Scan the repo's staging inbox. Symlinks are skipped: `slinky link` uses the
 * same layout, so a symlink here is a managed project link, not a fresh install.
 */
export const findStaged = Effect.fn("Adopt.findStaged")(function* (manifest: Manifest) {
  const { stagedSkills, stagedLock } = yield* HostRepo;
  const lock = readSkillLockFile(stagedLock);
  const staged: StagedSkill[] = [];

  for (const { name } of readdirIfExists(stagedSkills)) {
    const dir = join(stagedSkills, name);
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (!existsSync(join(dir, "SKILL.md"))) continue;

    const meta = lock.skills[name];
    const entry = lock.entries[name];
    const candidate: ForeignSkill = meta === undefined || entry === undefined ? { name, location: "staged", dir } : { name, location: "staged", dir, lock: meta, lockEntry: entry };
    const indexed = manifest.skills[name];
    if (!indexed) {
      staged.push({ candidate, status: { kind: "new" } });
      continue;
    }
    const same = contentHash(dir) === indexed.contentHash;
    staged.push({ candidate, status: same ? { kind: "duplicate", path: indexed.path } : { kind: "changed", path: indexed.path } });
  }

  const sortedStaged = staged.sort((a, b) => a.candidate.name.localeCompare(b.candidate.name));
  const scan: StagedScan = lock.warning === undefined ? { staged: sortedStaged } : { staged: sortedStaged, warning: lock.warning };
  return scan;
});

/**
 * Project-scoped locks carry `computedHash` (a content digest) but no
 * `skillFolderHash` (the git tree SHA `update --check` compares against).
 * Recover it from GitHub so adopting from the inbox does not lose tracking.
 * Best effort: an unreachable upstream just leaves the skill untracked.
 */
export const backfillTreeHash = Effect.fn("Adopt.backfillTreeHash")(function* (lock: LockMeta) {
  if (lock.sourceType !== "github" || lock.skillFolderHash !== undefined || lock.skillPath === undefined) return lock;
  const folder = posix.dirname(lock.skillPath);
  if (folder === "." || folder === "/") return lock;
  const parent = folder.includes("/") ? posix.dirname(folder) : "";
  const leaf = folder.split("/").pop();
  if (!leaf) return lock;

  const github = yield* GitHub;
  const shas = yield* github.contentsShas(lock.source, parent).pipe(Effect.catch(() => Effect.succeed(undefined)));
  const hash = shas?.get(leaf);
  return hash === undefined ? lock : ({ ...lock, skillFolderHash: hash } satisfies LockMeta);
});

/** Repo dirs that are Slinky's own or plainly not agent stores. */
const RESIDUE_SKIP = new Set(["skills", "vendor", "commands", ".agents", ".claude", ".git", ".local", "node_modules", "dist"]);

/** existsSync follows symlinks, so a dangling link reads as absent. */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop what skills.sh leaves behind once a staged skill has moved into the repo:
 * the `.claude` symlink now dangles, and a stale lock entry would make a later
 * `npx skills add` believe the skill is still installed and skip re-fetching it.
 */
export const clearStagingResidue = Effect.fn("Adopt.clearStagingResidue")(function* (name: string) {
  const { repo, stagedClaudeSkills, stagedLock } = yield* HostRepo;
  const warnings: string[] = [];

  const link = join(stagedClaudeSkills, name);
  try {
    if (lstatSync(link).isSymbolicLink() && !existsSync(link)) rmSync(link, { force: true });
  } catch (error) {
    if (!isMissingFile(error)) warnings.push(`${name}: could not remove ${link}: ${errorDetail(error)}`);
  }

  try {
    const raw = readFileSync(stagedLock, "utf8");
    const parsed = decodeJsonObject(JSON.parse(raw));
    const lockedSkills = parsed.skills;
    if (isJsonObject(lockedSkills) && Object.hasOwn(lockedSkills, name)) {
      const skills = Object.fromEntries(Object.entries(lockedSkills).filter(([skillName]) => skillName !== name));
      if (Object.keys(skills).length === 0) rmSync(stagedLock, { force: true });
      else writeFileSync(stagedLock, `${JSON.stringify({ ...parsed, skills }, null, 2)}\n`);
    }
  } catch (error) {
    if (!isMissingFile(error)) warnings.push(`${name}: could not prune ${stagedLock}: ${errorDetail(error)}`);
  }

  // `npx skills add` run by hand (without `-a universal`) also copies into every
  // agent dir it detects. Report those rather than delete them: guessing wrong
  // about what belongs to the user in their own worktree is the worse failure.
  for (const entry of readdirIfExists(repo)) {
    if (!entry.isDirectory() || RESIDUE_SKIP.has(entry.name)) continue;
    const copy = join(repo, entry.name, "skills", name);
    if (!pathExists(copy)) continue;
    warnings.push(`${name}: skills.sh also wrote ${posix.join(entry.name, "skills", name)}; remove it or add it to .gitignore`);
  }

  return warnings;
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
  readonly lockEntry?: SkillLockEntry;
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
    let adoption: Adoption = {
      manifest: withManifestSkill(manifest, candidate.name, meta),
      meta,
      destination: dest,
      sourceToRemove: keepLiveDir ? null : candidate.dir,
    };
    if (meta.origin !== "vendor" || !candidate.lock) return adoption;
    adoption = {
      ...adoption,
      lockEntry: canonicalLockEntry(candidate.lock, candidate.lockEntry, meta.vendoredAt === null ? undefined : formatUtc(meta.vendoredAt)),
    };
    return adoption;
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
