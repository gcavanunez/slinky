import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { Skill, getSkill, nowUtc, withManifestSkill } from "../domain/model.ts";
import type { Manifest, SkillLockDecodeError } from "../domain/model.ts";
import { readSkillLock, upstreamFromLock } from "./adopt.ts";
import { contentHash } from "./hash.ts";
import { AGENTS_SKILLS, REPO } from "./paths.ts";

const decodeSkill = Schema.decodeUnknownSync(Skill);

/** Accept the live global copy of a vendored skill into the repo. */
export function vendorAccept(
  manifest: Manifest,
  name: string,
): {
  readonly manifest: Manifest;
  readonly changed: boolean;
  readonly warning?: SkillLockDecodeError;
} {
  const meta = getSkill(manifest, name);
  if (!meta) throw new Error(`unknown skill: ${name}`);
  if (meta.origin !== "vendor") throw new Error(`${name} is a local skill; nothing to vendor`);

  const live = join(AGENTS_SKILLS, name);
  if (!existsSync(live)) throw new Error(`no live copy at ${live}`);

  const liveHash = contentHash(live);
  if (liveHash === meta.contentHash) return { manifest, changed: false };

  const dest = join(REPO, meta.path);
  rmSync(dest, { recursive: true, force: true });
  cpSync(live, dest, { recursive: true });

  const lock = readSkillLock();
  const next = decodeSkill({
    ...meta,
    contentHash: contentHash(dest),
    vendoredAt: nowUtc(),
    upstream: lock.skills[name] ? upstreamFromLock(lock.skills[name]) : meta.upstream,
  });
  return {
    manifest: withManifestSkill(manifest, name, next),
    changed: true,
    ...(lock.warning ? { warning: lock.warning } : {}),
  };
}

/** Restore the live global copy from the repo baseline (reject an update). */
export function vendorRestore(manifest: Manifest, name: string): void {
  const meta = getSkill(manifest, name);
  if (!meta) throw new Error(`unknown skill: ${name}`);
  if (meta.origin !== "vendor") throw new Error(`${name} is a local skill; it is symlinked, not copied`);
  const live = join(AGENTS_SKILLS, name);
  rmSync(live, { recursive: true, force: true });
  cpSync(join(REPO, meta.path), live, { recursive: true });
}
