import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Bun reads tsconfig.json from the cwd, not from the source file, so running
 * `slinky` inside a project that sets its own jsxImportSource used to retarget
 * the TUI's JSX at that project's runtime ("Cannot find module
 * 'vue/jsx-dev-runtime'"). The per-file @jsxImportSource pragmas pin it.
 */
test("the TUI loads from a cwd whose tsconfig sets a foreign jsxImportSource", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slinky-jsx-"));
  roots.push(cwd);
  mkdirSync(join(cwd, "node_modules"), { recursive: true });
  writeFileSync(join(cwd, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { jsx: "preserve", jsxImportSource: "vue" } })}\n`);

  const entry = join(import.meta.dir, "index.tsx");
  const result = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(entry)})`], { cwd });
  const stderr = result.stderr.toString();

  expect(stderr).not.toContain("vue/jsx-dev-runtime");
  expect(result.exitCode).toBe(0);
});
