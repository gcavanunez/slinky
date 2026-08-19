import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSkill, withManifestSkill } from "../domain/model.ts";
import type { Manifest } from "../domain/model.ts";
import { contentHash } from "./hash.ts";

export interface LocalHashRefresh {
  readonly manifest: Manifest;
  readonly refreshed: ReadonlyArray<string>;
}

/**
 * Recompute manifest hashes for local skills whose repo copy has drifted.
 *
 * Local skills are symlinked into the global store, so editing the installed copy edits the repo
 * copy directly and leaves the manifest hash stale. Only local skills are considered: a vendor
 * mismatch means the committed baseline was hand-edited instead of going through `slinky vendor`,
 * which must stay a verification failure rather than being silently absorbed.
 *
 * Skills that are already current, unknown, non-local, or missing from the repo are left untouched
 * so callers can report them on their own terms.
 */
export function refreshLocalHashes(manifest: Manifest, repo: string, names?: ReadonlyArray<string>): LocalHashRefresh {
  const targets =
    names ??
    Object.entries(manifest.skills)
      .filter(([, meta]) => meta.origin === "local")
      .map(([name]) => name);
  let next = manifest;
  const refreshed: string[] = [];
  for (const name of targets) {
    const meta = getSkill(next, name);
    if (!meta || meta.origin !== "local") continue;
    const path = join(repo, meta.path);
    if (!existsSync(path)) continue;
    const hash = contentHash(path);
    if (hash === meta.contentHash) continue;
    next = withManifestSkill(next, name, { ...meta, contentHash: hash });
    refreshed.push(name);
  }
  return { manifest: next, refreshed };
}
