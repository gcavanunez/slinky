import { stat } from "node:fs/promises";

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function requireReleaseBinary(path: string, targetId: string): Promise<void> {
  if (await isFile(path)) return;
  throw new Error(`SLINKY_REUSE_RELEASE_BINARY=1 requires an existing release binary for ${targetId}: ${path}`);
}

export async function assertBinaryIdentity(expectedPath: string, actualPath: string): Promise<void> {
  if (!(await isFile(expectedPath))) throw new Error(`Release binary does not exist: ${expectedPath}`);
  if (!(await isFile(actualPath))) throw new Error(`Release binary does not exist: ${actualPath}`);

  const [expectedHash, actualHash] = await Promise.all([sha256(expectedPath), sha256(actualPath)]);
  if (expectedHash !== actualHash) {
    throw new Error(`Release binary identity mismatch:\n${expectedHash}  ${expectedPath}\n${actualHash}  ${actualPath}`);
  }
}

if (import.meta.main) {
  const [expectedPath, actualPath] = process.argv.slice(2);
  if (!expectedPath || !actualPath) throw new Error("Usage: bun run scripts/release-artifact-identity.ts <expected-binary> <actual-binary>");
  await assertBinaryIdentity(expectedPath, actualPath);
}
