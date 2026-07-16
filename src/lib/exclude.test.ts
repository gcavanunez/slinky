import { describe, expect, test } from "bun:test";
import { addExcludeLines, EXCLUDE_MARKER, removeExcludeLines } from "./exclude.ts";

describe("addExcludeLines", () => {
  test("adds marker and lines to empty file", () => {
    const out = addExcludeLines("", ["/.agents/skills/foo/"]);
    expect(out).toBe(`${EXCLUDE_MARKER}\n/.agents/skills/foo/\n`);
  });

  test("preserves existing content", () => {
    const out = addExcludeLines("node_modules\n", ["/.agents/skills/foo/"]);
    expect(out).toBe(`node_modules\n${EXCLUDE_MARKER}\n/.agents/skills/foo/\n`);
  });

  test("dedupes lines", () => {
    const once = addExcludeLines("", ["/.agents/skills/foo/"]);
    expect(addExcludeLines(once, ["/.agents/skills/foo/"])).toBe(once);
  });

  test("does not duplicate the marker", () => {
    const once = addExcludeLines("", ["/a/"]);
    const twice = addExcludeLines(once, ["/b/"]);
    expect(twice.split("\n").filter((l) => l === EXCLUDE_MARKER)).toHaveLength(1);
    expect(twice).toContain("/a/");
    expect(twice).toContain("/b/");
  });
});

describe("removeExcludeLines", () => {
  test("removes lines and orphaned marker", () => {
    const content = addExcludeLines("node_modules\n", ["/a/", "/b/"]);
    const out = removeExcludeLines(content, ["/a/", "/b/"]);
    expect(out).not.toContain("/a/");
    expect(out).not.toContain("/b/");
    expect(out).not.toContain(EXCLUDE_MARKER);
    expect(out).toContain("node_modules");
  });

  test("keeps marker while managed entries remain", () => {
    const content = addExcludeLines("", ["/a/", "/b/"]);
    const out = removeExcludeLines(content, ["/a/"]);
    expect(out).toContain(EXCLUDE_MARKER);
    expect(out).toContain("/b/");
  });

  test("round-trip leaves original untouched", () => {
    const original = "node_modules\ndist\n";
    const out = removeExcludeLines(addExcludeLines(original, ["/x/"]), ["/x/"]);
    expect(out).toBe(original);
  });
});
