/**
 * The catalog pane is one flat list: a heading row per group, then that group's
 * items unless the group is folded. Selection is remembered by name rather than
 * position so it survives folding, filtering, and catalog reloads.
 */

export interface TreeGroup {
  readonly label: string;
  readonly skills: ReadonlyArray<unknown>;
}

export type ItemOf<Group extends TreeGroup> = Group["skills"][number];

export type TreeRow<Group extends TreeGroup> =
  | { readonly kind: "group"; readonly group: Group; readonly collapsed: boolean }
  | { readonly kind: "item"; readonly group: Group; readonly item: ItemOf<Group> };

/** Where the cursor is: a heading (no item) or an item within its group. */
export interface TreeSelection {
  readonly group: string;
  readonly item?: string;
}

/** Flatten groups into rows. `expandAll` ignores the fold state, which filtering uses so no match hides. */
export function treeRows<Group extends TreeGroup>(groups: ReadonlyArray<Group>, collapsed: ReadonlySet<string>, expandAll: boolean): TreeRow<Group>[] {
  const rows: TreeRow<Group>[] = [];
  for (const group of groups) {
    const folded = !expandAll && collapsed.has(group.label);
    rows.push({ kind: "group", group, collapsed: folded });
    if (folded) continue;
    // SAFETY: ItemOf<Group> is defined as the element type of Group["skills"], so the
    // cast only restores the type the TreeGroup constraint widened to unknown.
    for (const item of group.skills as ReadonlyArray<ItemOf<Group>>) rows.push({ kind: "item", group, item });
  }
  return rows;
}

export function firstItemIndex<Group extends TreeGroup>(rows: ReadonlyArray<TreeRow<Group>>): number {
  const index = rows.findIndex((row) => row.kind === "item");
  return index === -1 ? 0 : index;
}

/**
 * Resolve a remembered selection to a row index. An item hidden by a fold or a
 * filter falls back to its heading; a vanished group falls back to the first item.
 */
export function treeIndex<Group extends TreeGroup>(rows: ReadonlyArray<TreeRow<Group>>, selection: TreeSelection | null, itemName: (item: ItemOf<Group>) => string): number {
  if (selection === null) return firstItemIndex(rows);
  if (selection.item !== undefined) {
    const exact = rows.findIndex((row) => row.kind === "item" && row.group.label === selection.group && itemName(row.item) === selection.item);
    if (exact !== -1) return exact;
  }
  const heading = rows.findIndex((row) => row.kind === "group" && row.group.label === selection.group);
  return heading === -1 ? firstItemIndex(rows) : heading;
}

export function selectionOf<Group extends TreeGroup>(row: TreeRow<Group>, itemName: (item: ItemOf<Group>) => string): TreeSelection {
  return row.kind === "group" ? { group: row.group.label } : { group: row.group.label, item: itemName(row.item) };
}
