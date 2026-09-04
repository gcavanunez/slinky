export type Panel = "catalog" | "content" | "files";
export type PrimaryPanel = Exclude<Panel, "files">;

/** null shows both primaries side by side; otherwise the named primary fills the width. */
export type Layout = PrimaryPanel | null;

const order: ReadonlyArray<Layout> = [null, "catalog", "content"];

export function primaryPanel(panel: Panel): PrimaryPanel {
  return panel === "files" ? "content" : panel;
}

export function cycleLayout(layout: Layout, direction: 1 | -1): Layout {
  const index = order.indexOf(layout);
  return order[(index + direction + order.length) % order.length] ?? null;
}

/** Grow or shrink the catalog share of the split so the focused side gets the space. */
export function resizeFocusedSplit(split: number, panel: Panel, grow: boolean): number {
  const focusedOnLeft = panel === "catalog";
  const delta = (grow === focusedOnLeft ? 1 : -1) * 0.05;
  return Math.max(0.2, Math.min(0.8, split + delta));
}
