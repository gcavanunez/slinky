import { describe, expect, test } from "bun:test";
import { firstItemIndex, selectionOf, treeIndex, treeRows } from "./catalog-tree.ts";

const groups = [
  { label: "local", skills: ["alpha", "beta"] },
  { label: "acme", skills: ["gamma"] },
];
const name = (item: string) => item;

describe("catalog tree", () => {
  test("flattens groups into heading and item rows", () => {
    const rows = treeRows(groups, new Set(), false);
    expect(rows.map((row) => (row.kind === "group" ? `#${row.group.label}` : row.item))).toEqual(["#local", "alpha", "beta", "#acme", "gamma"]);
    expect(firstItemIndex(rows)).toBe(1);
  });

  test("folded groups keep their heading and drop their items", () => {
    const rows = treeRows(groups, new Set(["local"]), false);
    expect(rows.map((row) => (row.kind === "group" ? `#${row.group.label}` : row.item))).toEqual(["#local", "#acme", "gamma"]);
    expect(rows[0]).toMatchObject({ kind: "group", collapsed: true });
  });

  test("expandAll overrides folds while a filter is active", () => {
    expect(treeRows(groups, new Set(["local", "acme"]), true)).toHaveLength(5);
  });

  test("resolves a selection by name, falling back to the heading and then the first item", () => {
    const open = treeRows(groups, new Set(), false);
    expect(treeIndex(open, { group: "acme", item: "gamma" }, name)).toBe(4);
    expect(treeIndex(open, { group: "local" }, name)).toBe(0);
    expect(treeIndex(open, null, name)).toBe(1);

    const folded = treeRows(groups, new Set(["acme"]), false);
    expect(treeIndex(folded, { group: "acme", item: "gamma" }, name)).toBe(3);
    expect(treeIndex(folded, { group: "gone", item: "x" }, name)).toBe(1);
  });

  test("selectionOf round-trips a row", () => {
    const rows = treeRows(groups, new Set(), false);
    expect(selectionOf(rows[0]!, name)).toEqual({ group: "local" });
    expect(selectionOf(rows[2]!, name)).toEqual({ group: "local", item: "beta" });
  });
});
