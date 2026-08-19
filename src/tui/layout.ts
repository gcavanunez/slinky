export type Panel = "authors" | "skills" | "content" | "files";
export type PrimaryPanel = Exclude<Panel, "files">;
export type TwoPanePair = "catalog" | "document";

export interface LayoutState {
  readonly twoPane: TwoPanePair | null;
  readonly expanded: PrimaryPanel | null;
}

export function primaryPanel(panel: Panel): PrimaryPanel {
  return panel === "files" ? "content" : panel;
}

export function pairForPanel(panel: Panel): TwoPanePair {
  return panel === "content" || panel === "files" ? "document" : "catalog";
}

export function cycleLayout(state: LayoutState, panel: Panel, direction: 1 | -1): LayoutState {
  const focused = primaryPanel(panel);
  if (state.expanded) {
    return direction === 1 ? { twoPane: null, expanded: null } : { twoPane: pairForPanel(panel), expanded: null };
  }
  if (state.twoPane) {
    return direction === 1 ? { ...state, expanded: focused } : { twoPane: null, expanded: null };
  }
  return direction === 1 ? { twoPane: pairForPanel(panel), expanded: null } : { twoPane: null, expanded: focused };
}

export function resizeFocusedSplit(split: number, pair: TwoPanePair, panel: Panel, grow: boolean): number {
  const focusedOnLeft = pair === "catalog" ? panel === "authors" : panel === "skills";
  const delta = (grow === focusedOnLeft ? 1 : -1) * 0.05;
  return Math.max(0.2, Math.min(0.8, split + delta));
}
