import type { KeyEvent } from "@opentui/core";

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Pad/truncate a cell to an exact width so row backgrounds fill fully. */
export function fitCell(s: string, width: number, align: "left" | "right" = "left"): string {
  if (width <= 0) return "";
  if (s.length > width) return width > 1 ? s.slice(0, width - 1) + "\u2026" : s.slice(0, width);
  return align === "left" ? s.padEnd(width) : s.padStart(width);
}

/** Sliding window that keeps `selected` visible within `viewport` rows. */
export function windowOf(offset: number, selected: number, total: number, viewport: number): number {
  if (total <= viewport) return 0;
  let next = clamp(offset, 0, total - viewport);
  if (selected < next) next = selected;
  if (selected >= next + viewport) next = selected - viewport + 1;
  return clamp(next, 0, total - viewport);
}

/** Extract printable text from a key event (single chars; "space" -> " "). */
export function printable(key: Pick<KeyEvent, "name" | "sequence" | "ctrl" | "meta">): string {
  if (key.ctrl || key.meta) return "";
  if (key.name === "space") return " ";
  if (key.name && key.name.length === 1) return key.name;
  if (key.sequence && key.sequence.length >= 1 && !key.sequence.startsWith("\u001b")) {
    // paste or shifted chars arrive via sequence
    return [...key.sequence].filter((ch) => ch >= " " && ch !== "\u007f").join("");
  }
  return "";
}
