import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBinaryIdentity, requireReleaseBinary } from "./release-artifact-identity.ts";
import { assertPackageIntegrity } from "./release-package-identity.ts";
import { findReleaseTarget, standaloneCompileCommand } from "./release-targets.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slinky-release-artifact-"));
  roots.push(root);
  return root;
}

describe("release binary reuse", () => {
  test("rejects a missing release binary instead of allowing a rebuild", async () => {
    const path = join(await scratch(), "dist", "release", "linux-x64", "slinky");
    await expect(requireReleaseBinary(path, "linux-x64")).rejects.toThrow(`SLINKY_REUSE_RELEASE_BINARY=1 requires an existing release binary for linux-x64: ${path}`);
  });

  test("compares binary content exactly", async () => {
    const root = await scratch();
    const expected = join(root, "expected");
    const actual = join(root, "actual");
    await Promise.all([writeFile(expected, "same binary"), writeFile(actual, "same binary")]);
    await expect(assertBinaryIdentity(expected, actual)).resolves.toBeUndefined();

    await writeFile(actual, "rebuilt binary");
    await expect(assertBinaryIdentity(expected, actual)).rejects.toThrow("Release binary identity mismatch");
  });

  test("uses the OpenTUI libc define for every Linux compilation", () => {
    const target = findReleaseTarget("linux-x64");
    expect(target).not.toBeNull();
    if (!target) return;

    expect(standaloneCompileCommand(target, "/tmp/slinky")).toContain('process.env.OPENTUI_LIBC="glibc"');
  });

  test("requires complete npm package integrity to match", () => {
    expect(() => assertPackageIntegrity("@gcavanunez/slinky@1.0.0", "sha512-same", "sha512-same")).not.toThrow();
    expect(() => assertPackageIntegrity("@gcavanunez/slinky@1.0.0", "sha512-local", "sha512-published")).toThrow("npm package identity mismatch");
  });
});
