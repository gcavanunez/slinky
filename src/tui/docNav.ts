import { CodeRenderable } from "@opentui/core";
import type { MarkdownRenderable, ScrollBoxRenderable } from "@opentui/core";

/** The renderable hosting the preview document: markdown for .md files, code otherwise. */
export type DocRenderable = MarkdownRenderable | CodeRenderable;

function countNewlines(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) count++;
  return count;
}

/** Rendered row for a source line within one code renderable (wrap + conceal aware). */
function rowInCode(code: CodeRenderable, line: number): number {
  const sources = code.lineInfo.lineSources;
  if (!sources || sources.length === 0) return Math.max(0, line);
  const exact = sources.indexOf(line);
  if (exact !== -1) return exact;
  const after = sources.findIndex((source) => source >= line);
  return after !== -1 ? after : sources.length - 1;
}

/**
 * Map a zero-based source line of the rendered document to a scrollTop row in
 * the preview scrollbox. Exact for code files and for markdown blocks backed by
 * code renderables (paragraphs, headings, fences); block-level precision for
 * tables/lists; proportional fallback when block metadata is unavailable.
 */
export function scrollRowForLine(doc: DocRenderable, scroll: ScrollBoxRenderable, line: number, totalLines: number): number {
  const contentTop = scroll.content.y;
  if (doc instanceof CodeRenderable) return doc.y - contentTop + rowInCode(doc, line);

  const tokens = doc._parseState?.tokens ?? [];
  const states = doc._blockStates;
  let cursor = 0;
  let stateIndex = 0;
  let best: { renderable: { y: number }; startLine: number } | null = null;
  for (const token of tokens) {
    const raw = token.raw;
    const lineCount = countNewlines(raw);
    const state = states[stateIndex];
    if (state && (state.token === token || state.tokenRaw === raw)) {
      best = { renderable: state.renderable, startLine: cursor };
      if (line < cursor + Math.max(1, lineCount)) break;
      stateIndex++;
    }
    cursor += lineCount;
  }
  if (best) {
    const local = Math.max(0, line - best.startLine);
    const inner = best.renderable;
    const row = inner instanceof CodeRenderable ? rowInCode(inner, local) : 0;
    return inner.y - contentTop + row;
  }
  // No block metadata yet: approximate by document proportion.
  const height = Math.max(0, scroll.scrollHeight - 1);
  return totalLines > 0 ? Math.round((line / totalLines) * height) : 0;
}
