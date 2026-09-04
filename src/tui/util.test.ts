import { describe, expect, test } from "bun:test";
import { fileTreeRows, fitCell, markdownBody, markdownFrontmatter, markdownHeadingLines, printable, searchMatchLines, singleLinePaste, windowOf } from "./util.ts";

describe("fitCell", () => {
  test("pads to width", () => {
    expect(fitCell("ab", 5)).toBe("ab   ");
    expect(fitCell("ab", 5, "right")).toBe("   ab");
  });
  test("truncates with ellipsis", () => {
    expect(fitCell("abcdef", 4)).toBe("abc\u2026");
  });
  test("zero width", () => {
    expect(fitCell("abc", 0)).toBe("");
  });
});

describe("windowOf", () => {
  test("no scroll when everything fits", () => {
    expect(windowOf(0, 5, 8, 10)).toBe(0);
  });
  test("follows selection below the window", () => {
    expect(windowOf(0, 12, 50, 10)).toBe(3);
  });
  test("follows selection above the window", () => {
    expect(windowOf(20, 5, 50, 10)).toBe(5);
  });
  test("clamps to end", () => {
    expect(windowOf(45, 49, 50, 10)).toBe(40);
  });
});

describe("printable", () => {
  test("single char", () => {
    expect(printable({ name: "a", sequence: "a", ctrl: false, meta: false })).toBe("a");
  });
  test("shifted char preserves case", () => {
    expect(printable({ name: "x", sequence: "X", ctrl: false, meta: false })).toBe("X");
  });
  test("space keyword", () => {
    expect(printable({ name: "space", sequence: " ", ctrl: false, meta: false })).toBe(" ");
  });
  test("ctrl chords ignored", () => {
    expect(printable({ name: "c", sequence: "\u0003", ctrl: true, meta: false })).toBe("");
  });
  test("escape sequences ignored", () => {
    expect(printable({ name: "up", sequence: "\u001b[A", ctrl: false, meta: false })).toBe("");
  });
  test("paste via sequence", () => {
    expect(printable({ name: "", sequence: "/home/x", ctrl: false, meta: false })).toBe("/home/x");
  });
});

describe("singleLinePaste", () => {
  test("decodes paste bytes and replaces line breaks", () => {
    expect(singleLinePaste(new TextEncoder().encode("skills add acme/skills\r\n--skill effect\n"))).toBe("skills add acme/skills --skill effect ");
  });
});

describe("fileTreeRows", () => {
  test("expands shared folders once", () => {
    expect(fileTreeRows(["SKILL.md", "references/auth.md", "references/setup.md"])).toEqual([
      { kind: "file", path: "SKILL.md", label: "SKILL.md", depth: 0 },
      { kind: "folder", path: "references", label: "references", depth: 0 },
      { kind: "file", path: "references/auth.md", label: "auth.md", depth: 1 },
      { kind: "file", path: "references/setup.md", label: "setup.md", depth: 1 },
    ]);
  });
});

describe("searchMatchLines", () => {
  test("matches case-insensitively", () => {
    expect(searchMatchLines(["Alpha", "beta", "ALPHA beta"], "alpha")).toEqual([0, 2]);
  });
  test("empty query matches nothing", () => {
    expect(searchMatchLines(["a", "b"], "")).toEqual([]);
  });
  test("no hits", () => {
    expect(searchMatchLines(["a", "b"], "zzz")).toEqual([]);
  });
});

describe("markdownHeadingLines", () => {
  test("finds ATX headings at every level", () => {
    expect(markdownHeadingLines(["# One", "text", "## Two", "###### Six", "####### not a heading", "#nospace"])).toEqual([0, 2, 3]);
  });
  test("skips headings inside fenced code blocks", () => {
    expect(markdownHeadingLines(["# Real", "```bash", "# comment", "```", "## After"])).toEqual([0, 4]);
  });
  test("tilde fences do not close backtick fences", () => {
    expect(markdownHeadingLines(["```", "~~~", "# hidden", "```", "# shown"])).toEqual([4]);
  });
});

describe("markdownBody", () => {
  test("removes SKILL.md frontmatter from the rendered body", () => {
    expect(markdownBody("SKILL.md", "---\nname: test\ndescription: Test.\n---\n\n# Test\n")).toBe("\n# Test\n");
  });

  test("shows frontmatter as a yaml fence when asked", () => {
    const content = "---\nname: test\ndescription: Test.\n---\n\n# Test\n";
    expect(markdownBody("SKILL.md", content, true)).toBe("```yaml\nname: test\ndescription: Test.\n```\n\n# Test\n");
    expect(markdownFrontmatter(content)).toBe("name: test\ndescription: Test.");
    expect(markdownFrontmatter("# Test\n")).toBeNull();
  });

  test("preserves related Markdown and body horizontal rules", () => {
    const content = "# Notes\n\n---\n\nMore\n";
    expect(markdownBody("references/notes.md", content)).toBe(content);
    expect(markdownBody("SKILL.md", content)).toBe(content);
  });
});
