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

/** Centre text within `width`, padding both sides so a row background fills fully. */
export function centerCell(s: string, width: number): string {
  if (width <= 0) return "";
  if (s.length >= width) return fitCell(s, width);
  const left = Math.floor((width - s.length) / 2);
  return `${" ".repeat(left)}${s}`.padEnd(width);
}

/** Greedy word wrap; words longer than `width` are split. Always yields at least one line. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word;
      }
      while (line.length > width && width > 0) {
        lines.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
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
  if (key.sequence && key.sequence.length >= 1 && !key.sequence.startsWith("\u001b")) {
    // Shifted characters and paste preserve their exact casing through sequence.
    return [...key.sequence].filter((ch) => ch >= " " && ch !== "\u007f").join("");
  }
  if (key.name === "space") return " ";
  if (key.name && key.name.length === 1) return key.name;
  return "";
}

/** Decode bracketed paste bytes for a single-line text field. */
export function singleLinePaste(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/[\r\n]+/g, " ");
}

export interface FileTreeRow {
  kind: "folder" | "file";
  path: string;
  label: string;
  depth: number;
}

/** Expand relative file paths into a compact, always-open file tree. */
export function fileTreeRows(files: ReadonlyArray<string>): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const seenFolders = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 0; index < parts.length - 1; index++) {
      const path = parts.slice(0, index + 1).join("/");
      if (seenFolders.has(path)) continue;
      seenFolders.add(path);
      rows.push({ kind: "folder", path, label: parts[index] ?? path, depth: index });
    }
    rows.push({
      kind: "file",
      path: file,
      label: parts.at(-1) ?? file,
      depth: Math.max(0, parts.length - 1),
    });
  }
  return rows;
}

/** Hide skill metadata from the rendered document while preserving the source file itself. */
export function markdownBody(file: string, content: string): string {
  if (file !== "SKILL.md") return content;
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

/** Zero-based line indices whose text contains `query` (case-insensitive). */
export function searchMatchLines(lines: ReadonlyArray<string>, query: string): number[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").toLowerCase().includes(q)) out.push(i);
  }
  return out;
}

/** Zero-based line indices of ATX headings, skipping fenced code blocks. */
export function markdownHeadingLines(lines: ReadonlyArray<string>): number[] {
  const out: number[] = [];
  let fence: "`" | "~" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.startsWith("`") ? "`" : "~";
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence === null && /^#{1,6}\s/.test(line)) out.push(i);
  }
  return out;
}
