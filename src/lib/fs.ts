import { readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { Schema } from "effect";

const MissingDirError = Schema.instanceOf(Error).check(Schema.makeFilter((error) => "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")));
const isMissingDir = Schema.is(MissingDirError);

/** List a directory that may not exist; a missing dir is empty, other errors surface. */
export function readdirIfExists(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDir(error)) return [];
    throw error;
  }
}
