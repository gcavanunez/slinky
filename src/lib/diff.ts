import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkFiles } from "./hash.ts";

export interface DirDiff {
  added: string[]; // present in `b` only
  removed: string[]; // present in `a` only
  modified: string[];
  unchanged: number;
}

/** Compare two directory trees. `a` is the baseline (repo copy), `b` the live copy. */
export function diffDirs(a: string, b: string): DirDiff {
  const aFiles = new Set(walkFiles(a));
  const bFiles = new Set(walkFiles(b));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  let unchanged = 0;

  for (const f of [...bFiles].sort()) {
    if (!aFiles.has(f)) added.push(f);
  }
  for (const f of [...aFiles].sort()) {
    if (!bFiles.has(f)) {
      removed.push(f);
    } else if (Buffer.compare(readFileSync(join(a, f)), readFileSync(join(b, f))) !== 0) {
      modified.push(f);
    } else {
      unchanged++;
    }
  }
  return { added, removed, modified, unchanged };
}

export const isClean = (d: DirDiff) => d.added.length === 0 && d.removed.length === 0 && d.modified.length === 0;

/** Render a unified diff via the system `diff -ruN`. */
export function unifiedDiff(a: string, b: string): string {
  const res = spawnSync("diff", ["-ruN", a, b], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return res.stdout ?? "";
}
