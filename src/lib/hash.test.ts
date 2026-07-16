import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, walkFiles } from "./hash.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "skills-hash-"));
}

describe("contentHash", () => {
  test("deterministic for same content", () => {
    const a = scratch();
    const b = scratch();
    for (const dir of [a, b]) {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "SKILL.md"), "hello");
      writeFileSync(join(dir, "sub", "ref.md"), "world");
    }
    expect(contentHash(a)).toBe(contentHash(b));
  });

  test("changes when content changes", () => {
    const dir = scratch();
    writeFileSync(join(dir, "SKILL.md"), "hello");
    const before = contentHash(dir);
    writeFileSync(join(dir, "SKILL.md"), "hello!");
    expect(contentHash(dir)).not.toBe(before);
  });

  test("changes when a file is renamed", () => {
    const a = scratch();
    const b = scratch();
    writeFileSync(join(a, "x.md"), "same");
    writeFileSync(join(b, "y.md"), "same");
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  test("ignores junk files that git would not track", () => {
    const dir = scratch();
    writeFileSync(join(dir, "SKILL.md"), "hello");
    const before = contentHash(dir);
    mkdirSync(join(dir, "__pycache__"));
    writeFileSync(join(dir, "__pycache__", "mod.cpython-310.pyc"), "junk");
    writeFileSync(join(dir, "stray.pyc"), "junk");
    writeFileSync(join(dir, ".DS_Store"), "junk");
    expect(contentHash(dir)).toBe(before);
  });

  test("ignores symlinks", () => {
    const dir = scratch();
    writeFileSync(join(dir, "SKILL.md"), "hello");
    const before = contentHash(dir);
    symlinkSync("/nonexistent", join(dir, "dangling"));
    expect(contentHash(dir)).toBe(before);
  });

  test("matches the Phase 1 python hasher", () => {
    // python: sha256(b"SKILL.md\0hello\0sub/ref.md\0world\0")
    const dir = scratch();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "SKILL.md"), "hello");
    writeFileSync(join(dir, "sub", "ref.md"), "world");
    const h = new Bun.CryptoHasher("sha256");
    h.update("SKILL.md\0hello\0sub/ref.md\0world\0");
    expect(String(contentHash(dir))).toBe(h.digest("hex"));
  });
});

describe("walkFiles", () => {
  test("returns relative posix paths", () => {
    const dir = scratch();
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "c.md"), "x");
    writeFileSync(join(dir, "root.md"), "x");
    expect(walkFiles(dir).sort()).toEqual(["a/b/c.md", "root.md"]);
  });
});
