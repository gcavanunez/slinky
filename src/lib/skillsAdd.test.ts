import { describe, expect, test } from "bun:test";
import { parseSkillsAddSource } from "./skillsAdd.ts";

describe("parseSkillsAddSource", () => {
  test("accepts a source by itself", () => {
    expect(parseSkillsAddSource("kitlangton/skills", "effect")).toBe("kitlangton/skills");
  });

  test("accepts pasted skills.sh and Slinky commands", () => {
    expect(parseSkillsAddSource("skills add kitlangton/skills --skill effect", "effect")).toBe("kitlangton/skills");
    expect(parseSkillsAddSource("npx -y skills add kitlangton/skills --skill=effect --global --yes", "effect")).toBe("kitlangton/skills");
    expect(parseSkillsAddSource("slinky skills add kitlangton/skills --skill effect", "effect")).toBe("kitlangton/skills");
  });

  test("rejects a command for a different skill", () => {
    expect(() => parseSkillsAddSource("skills add kitlangton/skills --skill cause", "effect")).toThrow("command must select --skill effect");
  });
});
