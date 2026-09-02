import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

const NpmPackResults = Schema.Array(Schema.Struct({ integrity: Schema.String }));

function runNpm(args: ReadonlyArray<string>): string {
  const result = Bun.spawnSync(["npm", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `npm ${args.join(" ")} exited with ${result.exitCode}`);
  return result.stdout.toString().trim();
}

export function assertPackageIntegrity(packageSpec: string, localIntegrity: string, publishedIntegrity: string): void {
  if (localIntegrity === publishedIntegrity) return;
  throw new Error(`npm package identity mismatch for ${packageSpec}:\nlocal:     ${localIntegrity}\npublished: ${publishedIntegrity}`);
}

export async function assertPublishedPackageIdentity(packageDir: string, packageSpec: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "slinky-package-identity-"));
  try {
    const packed = Schema.decodeUnknownSync(NpmPackResults)(JSON.parse(runNpm(["pack", packageDir, "--json", "--pack-destination", directory])));
    const localIntegrity = packed[0]?.integrity;
    if (!localIntegrity) throw new Error(`npm pack did not report integrity for ${packageDir}`);
    const publishedIntegrity = runNpm(["view", packageSpec, "dist.integrity"]);
    assertPackageIntegrity(packageSpec, localIntegrity, publishedIntegrity);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [packageDir, packageSpec] = process.argv.slice(2);
  if (!packageDir || !packageSpec) throw new Error("Usage: bun run scripts/release-package-identity.ts <package-dir> <package-name@version>");
  await assertPublishedPackageIdentity(packageDir, packageSpec);
}
