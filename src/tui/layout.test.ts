import { describe, expect, test } from "bun:test";
import { cycleLayout, resizeFocusedSplit } from "./layout.ts";

describe("TUI layouts", () => {
  test("cycles split, catalog, document, and back", () => {
    expect(cycleLayout(null, 1)).toBe("catalog");
    expect(cycleLayout("catalog", 1)).toBe("content");
    expect(cycleLayout("content", 1)).toBeNull();
    expect(cycleLayout(null, -1)).toBe("content");
  });

  test("grows and shrinks whichever side is focused", () => {
    expect(resizeFocusedSplit(0.4, "catalog", true)).toBeCloseTo(0.45);
    expect(resizeFocusedSplit(0.4, "content", true)).toBeCloseTo(0.35);
    expect(resizeFocusedSplit(0.4, "files", false)).toBeCloseTo(0.45);
    expect(resizeFocusedSplit(0.8, "catalog", true)).toBeCloseTo(0.8);
  });
});
