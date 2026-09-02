import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { errorDetail, formatUtc, getSkill, isMissingFile, nowUtc, OperationFailed, Skill, withManifestSkill } from "../domain/model.ts";
import type { Manifest, SkillLockDecodeError } from "../domain/model.ts";
import { classifyPlacement } from "./catalogInspection.ts";
import { contentHash } from "./hash.ts";
import { HostRepo, Paths } from "./paths.ts";
import { observe } from "./reconcile.ts";
import { readSkillLockFile, upstreamFromLock } from "./skillLock.ts";
import type { SkillLockSnapshot } from "./skillLock.ts";

const decodeSkill = Schema.decodeUnknownSync(Skill);

function liveVendorKind(path: string): "dir" | "missing" | "unowned" {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "dir" : "unowned";
  } catch (error) {
    if (isMissingFile(error)) return "missing";
    throw error;
  }
}

export const assertVendorUpdatePlacements = Effect.fn("Vendor.assertUpdatePlacements")(function* (manifest: Manifest, names: ReadonlyArray<string>, force = false) {
  if (force) return;
  const { repo } = yield* HostRepo;
  const observation = yield* observe();
  for (const name of names) {
    const meta = getSkill(manifest, name);
    if (!meta || meta.origin !== "vendor") continue;
    const live = observation.agents[name] ?? { kind: "missing" as const };
    const placement = classifyPlacement(live, resolve(repo, meta.path));
    if (placement === "wrong-symlink" || placement === "expected-symlink" || placement === "file") {
      return yield* Effect.fail(new OperationFailed({ message: `${name}: live placement is not an owned vendor directory; reconcile it or use --force` }));
    }
  }
});

/** List vendored skills whose live directory differs from the catalog baseline. */
export const findDriftingVendors = Effect.fn("Vendor.findDrifting")(function* (manifest: Manifest) {
  const paths = yield* Paths;
  const observation = yield* observe();
  return Object.entries(manifest.skills)
    .filter(([name, meta]) => {
      const live = observation.agents[name];
      return meta.origin === "vendor" && live?.kind === "dir" && contentHash(join(paths.agentsSkills, name)) !== meta.contentHash;
    })
    .map(([name]) => name);
});

export interface VendorAcceptResult {
  readonly manifest: Manifest;
  readonly changed: boolean;
  readonly warning?: SkillLockDecodeError;
}

export interface VendorAcceptOptions {
  readonly refreshProvenance?: boolean;
  readonly provenance?: SkillLockSnapshot;
}

/** Accept the live global copy of a vendored skill into the repo. */
export const vendorAccept = Effect.fn("Vendor.accept")(function* (manifest: Manifest, name: string, options: VendorAcceptOptions = {}) {
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;

  const meta = getSkill(manifest, name);
  if (!meta) return yield* Effect.fail(new OperationFailed({ message: `unknown skill: ${name}` }));
  if (meta.origin !== "vendor") return yield* Effect.fail(new OperationFailed({ message: `${name} is a local skill; nothing to vendor` }));

  const live = join(paths.agentsSkills, name);
  const liveKind = yield* Effect.try({
    try: () => liveVendorKind(live),
    catch: (error) => new OperationFailed({ message: `${name}: could not inspect live copy: ${errorDetail(error)}` }),
  });
  if (liveKind === "missing") return yield* Effect.fail(new OperationFailed({ message: `no live copy at ${live}` }));
  if (liveKind === "unowned") return yield* Effect.fail(new OperationFailed({ message: `${name}: live copy is not an owned directory` }));

  const liveHash = contentHash(live);
  if (liveHash === meta.contentHash) {
    const unchanged: VendorAcceptResult = { manifest, changed: false };
    return unchanged;
  }

  const dest = join(repo, meta.path);
  rmSync(dest, { recursive: true, force: true });
  cpSync(live, dest, { recursive: true });

  const lock = options.refreshProvenance ? (options.provenance ?? readSkillLockFile(paths.skillLock)) : undefined;
  const next = decodeSkill({
    ...meta,
    contentHash: contentHash(dest),
    vendoredAt: formatUtc(nowUtc()),
    upstream: lock?.skills[name] ? upstreamFromLock(lock.skills[name]) : meta.upstream,
  });
  const nextManifest = withManifestSkill(manifest, name, next);
  const accepted: VendorAcceptResult = lock?.warning === undefined ? { manifest: nextManifest, changed: true } : { manifest: nextManifest, changed: true, warning: lock.warning };
  return accepted;
});

/** Restore the live global copy from the repo baseline (reject an update). */
export const vendorRestore = Effect.fn("Vendor.restore")(function* (manifest: Manifest, name: string) {
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;

  const meta = getSkill(manifest, name);
  if (!meta) return yield* Effect.fail(new OperationFailed({ message: `unknown skill: ${name}` }));
  if (meta.origin !== "vendor") return yield* Effect.fail(new OperationFailed({ message: `${name} is a local skill; it is symlinked, not copied` }));
  const source = join(repo, meta.path);
  if (!existsSync(source)) return yield* Effect.fail(new OperationFailed({ message: `${name}: repo copy missing at ${meta.path}` }));
  const live = join(paths.agentsSkills, name);
  const liveKind = yield* Effect.try({
    try: () => liveVendorKind(live),
    catch: (error) => new OperationFailed({ message: `${name}: could not inspect live copy: ${errorDetail(error)}` }),
  });
  if (liveKind === "unowned") return yield* Effect.fail(new OperationFailed({ message: `${name}: live copy is not an owned directory` }));
  mkdirSync(paths.agentsSkills, { recursive: true });
  const staging = mkdtempSync(join(paths.agentsSkills, ".slinky-restore-"));
  const replacement = join(staging, name);
  try {
    cpSync(source, replacement, { recursive: true });
    rmSync(live, { recursive: true, force: true });
    renameSync(replacement, live);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});
