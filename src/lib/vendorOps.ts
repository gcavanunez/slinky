import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { formatUtc, getSkill, nowUtc, OperationFailed, Skill, withManifestSkill } from "../domain/model.ts";
import type { Manifest, SkillLockDecodeError } from "../domain/model.ts";
import { contentHash } from "./hash.ts";
import { HostRepo, Paths } from "./paths.ts";
import { readSkillLockFile, upstreamFromLock } from "./skillLock.ts";

const decodeSkill = Schema.decodeUnknownSync(Skill);

export interface VendorAcceptResult {
  readonly manifest: Manifest;
  readonly changed: boolean;
  readonly warning?: SkillLockDecodeError;
}

export interface VendorAcceptOptions {
  readonly refreshProvenance?: boolean;
}

/** Accept the live global copy of a vendored skill into the repo. */
export const vendorAccept = Effect.fn("Vendor.accept")(function* (manifest: Manifest, name: string, options: VendorAcceptOptions = {}) {
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;

  const meta = getSkill(manifest, name);
  if (!meta) return yield* Effect.fail(new OperationFailed({ message: `unknown skill: ${name}` }));
  if (meta.origin !== "vendor") return yield* Effect.fail(new OperationFailed({ message: `${name} is a local skill; nothing to vendor` }));

  const live = join(paths.agentsSkills, name);
  if (!existsSync(live)) return yield* Effect.fail(new OperationFailed({ message: `no live copy at ${live}` }));

  const liveHash = contentHash(live);
  if (liveHash === meta.contentHash) {
    const unchanged: VendorAcceptResult = { manifest, changed: false };
    return unchanged;
  }

  const dest = join(repo, meta.path);
  rmSync(dest, { recursive: true, force: true });
  cpSync(live, dest, { recursive: true });

  const lock = options.refreshProvenance ? readSkillLockFile(paths.skillLock) : undefined;
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
  const live = join(paths.agentsSkills, name);
  rmSync(live, { recursive: true, force: true });
  cpSync(join(repo, meta.path), live, { recursive: true });
});
