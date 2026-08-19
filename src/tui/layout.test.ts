import { describe, expect, test } from "bun:test";
import { cycleLayout, resizeFocusedSplit } from "./layout.ts";

describe("TUI layouts", () => {
  test("cycles forward through contextual two-pane, focused full-screen, and three-pane layouts", () => {
    const three = { twoPane: null, expanded: null };
    const two = cycleLayout(three, "skills", 1);
    const full = cycleLayout(two, "skills", 1);

    expect(two).toEqual({ twoPane: "catalog", expanded: null });
    expect(full).toEqual({ twoPane: "catalog", expanded: "skills" });
    expect(cycleLayout(full, "skills", 1)).toEqual(three);
  });

  test("cycles backward through focused full-screen and the contextual document pair", () => {
    const three = { twoPane: null, expanded: null };
    const full = cycleLayout(three, "files", -1);
    const two = cycleLayout(full, "files", -1);

    expect(full).toEqual({ twoPane: null, expanded: "content" });
    expect(two).toEqual({ twoPane: "document", expanded: null });
    expect(cycleLayout(two, "files", -1)).toEqual(three);
  });

  test("grows and shrinks whichever side is focused", () => {
    expect(resizeFocusedSplit(1 / 3, "catalog", "authors", true)).toBeCloseTo(1 / 3 + 0.05);
    expect(resizeFocusedSplit(1 / 3, "catalog", "skills", true)).toBeCloseTo(1 / 3 - 0.05);
    expect(resizeFocusedSplit(0.4, "document", "content", false)).toBeCloseTo(0.45);
  });
});
