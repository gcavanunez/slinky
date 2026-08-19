import { describe, expect, mock, test } from "bun:test";
import { editableHostSkillPath, editSkillInNvim, withSuspendedRenderer } from "./external.ts";

describe("TUI external tools", () => {
  test("edits only local host skills from an explicit skill context", () => {
    expect(editableHostSkillPath(true, { origin: "local", path: "skills/mine" }, undefined)).toBe("skills/mine");
    expect(editableHostSkillPath(true, undefined, { origin: "local", path: "skills/new" })).toBe("skills/new");
    expect(editableHostSkillPath(true, { origin: "vendor", path: "vendor/acme/theirs" }, undefined)).toBeNull();
    expect(editableHostSkillPath(true, undefined, { origin: "vendor", path: "vendor/acme/new" })).toBeNull();
    expect(editableHostSkillPath(true, undefined, { origin: "agent", path: ".agents/skills/staged" })).toBeNull();
    expect(editableHostSkillPath(false, { origin: "local", path: "skills/hidden" }, undefined)).toBeNull();
  });

  test("runs nvim for a host-relative skill path from the skills repository", () => {
    const spawn = mock(() => ({ status: 0 }));

    editSkillInNvim("/home/user/my-agent-skills", "skills/my-skill", spawn);

    expect(spawn).toHaveBeenCalledWith("nvim", ["skills/my-skill"], {
      cwd: "/home/user/my-agent-skills",
      stdio: "inherit",
    });
  });

  test("always resumes the renderer after an external tool exits", () => {
    const calls: string[] = [];
    const renderer = {
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
    };

    expect(() =>
      withSuspendedRenderer(renderer, () => {
        calls.push("action");
        throw new Error("failed");
      }),
    ).toThrow("failed");
    expect(calls).toEqual(["suspend", "action", "resume"]);
  });
});
