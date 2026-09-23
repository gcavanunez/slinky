import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigProvider, Effect, Layer } from "effect";
import { findForeign } from "./adopt.ts";
import { adoptForeignSkill } from "./foreign-adoption.ts";
import { layerApp } from "./layers.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("adopts a foreign skill and reconciles the canonical global stores", () => {
  const root = mkdtempSync(join(tmpdir(), "slinky-foreign-adoption-"));
  roots.push(root);
  const host = join(root, "host");
  const home = join(root, "home");
  const foreign = join(home, ".claude", "skills", "foreign-skill");
  mkdirSync(join(host, ".local"), { recursive: true });
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "SKILL.md"), "---\nname: foreign-skill\ndescription: fixture\n---\n");
  writeFileSync(join(host, "skills.manifest.json"), `${JSON.stringify({ version: 1, skills: {}, profiles: {} })}\n`);
  writeFileSync(join(host, ".local", "state.json"), `${JSON.stringify({ version: 2, selection: { kind: "custom", disabledSkills: [] }, projectLinks: [], recentProjects: [] })}\n`);

  const layer = layerApp.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home, SLINKY_REPO: host }))));
  const result = Effect.runSync(
    Effect.gen(function* () {
      const scan = yield* findForeign({ version: 1, skills: {}, profiles: {} });
      const candidate = scan.candidates[0];
      if (!candidate) throw new Error("expected a foreign skill");
      return yield* adoptForeignSkill(candidate, { local: true });
    }).pipe(Effect.provide(layer)),
  );

  expect(result.path).toBe("skills/foreign-skill");
  expect(JSON.parse(readFileSync(join(host, "skills.manifest.json"), "utf8")).skills["foreign-skill"].origin).toBe("local");
  expect(lstatSync(join(home, ".agents", "skills", "foreign-skill")).isSymbolicLink()).toBe(true);
  expect(resolve(join(home, ".agents", "skills"), readlinkSync(join(home, ".agents", "skills", "foreign-skill")))).toBe(join(host, "skills", "foreign-skill"));
  expect(lstatSync(join(home, ".claude", "skills", "foreign-skill")).isSymbolicLink()).toBe(true);
});
