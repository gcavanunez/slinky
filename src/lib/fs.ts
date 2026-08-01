import { readdirSync } from "node:fs";
import type { Dirent } from "node:fs";

const isMissingDir = (error: unknown): boolean => error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

/** List a directory that may not exist; a missing dir is empty, other errors surface. */
export function readdirIfExists(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDir(error)) return [];
    throw error;
  }
}
