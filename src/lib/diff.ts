import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFiles } from "./hash.ts";

export interface DirDiff {
  added: string[]; // present in `b` only
  removed: string[]; // present in `a` only
  modified: string[];
  unchanged: number;
}

export type DiffPager = "hunk" | "delta";

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
  const temp = mkdtempSync(join(tmpdir(), "slinky-diff-"));
  const output = join(temp, "patch.diff");
  const descriptor = openSync(output, "w");
  try {
    const result = spawnSync("diff", ["-ruN", a, b], { encoding: "utf8", stdio: ["ignore", descriptor, "pipe"] });
    if (result.error) throw result.error;
    // diff uses 1 for a successful comparison that found differences.
    if (result.status !== 0 && result.status !== 1) {
      const detail = String(result.stderr ?? "").trim();
      throw new Error(detail || `diff exited with ${result.status ?? "unknown"}`);
    }
    return readFileSync(output, "utf8");
  } finally {
    closeSync(descriptor);
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Open a raw unified patch in an interactive diff pager. */
export function pagePatch(patch: string, pager: DiffPager): void {
  const command: readonly [string, ...string[]] = pager === "hunk" ? ["hunk", "patch", "-"] : ["delta"];
  const [executable, ...args] = command;
  const result = spawnSync(executable, args, {
    input: patch,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${pager} exited with ${result.status ?? "unknown"}`);
}
