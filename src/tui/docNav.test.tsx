/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { SyntaxStyle } from "@opentui/core";
import type { CodeRenderable, MarkdownRenderable, ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { useEffect, useRef, useState } from "react";
import { scrollRowForLine } from "./docNav.ts";

/**
 * scrollRowForLine reads MarkdownRenderable._parseState and ._blockStates,
 * which OpenTUI types as public but does not document, and it only receives
 * per-block metadata under the experimental internalBlockMode="top-level".
 *
 * These tests assert what the user sees — that jumping to a line puts that line
 * at the top of the viewport — rather than the shape of the internals. An
 * upgrade that changes those internals degrades the mapping to a proportional
 * guess silently, with no error anywhere, so this is the only thing standing
 * between an OpenTUI bump and quietly broken `/`, `n`, `{` and `}`.
 */

const style = SyntaxStyle.fromTheme([{ scope: ["default"], style: { foreground: "#ffffff" } }]);

const HEADINGS = ["# Heading One", "## Heading Two", "## Heading Three"] as const;

// The table and list are load-bearing. They are the blocks that render as
// something other than a code renderable, so they are where per-block metadata
// changes the answer: under the default "coalesced" mode the jump to the
// heading after them lands two rows short.
const markdownLines = [
  HEADINGS[0],
  "",
  "Intro paragraph.",
  "",
  "| column | value |",
  "| ------ | ----- |",
  "| one    | 1     |",
  "| two    | 2     |",
  "",
  "- first item",
  "- second item",
  "- third item",
  "",
  HEADINGS[1],
  "",
  ...Array.from({ length: 30 }, (_, i) => `Body line ${i}.`),
  "",
  HEADINGS[2],
  "",
  "Closing paragraph with a UNIQUEMARKER token.",
];
const markdownSource = markdownLines.join("\n");
const codeLines = Array.from({ length: 60 }, (_, i) => `const value${i} = ${i};`);
const codeSource = codeLines.join("\n");

const VIEWPORT_HEIGHT = 20;

type Captured = { doc: MarkdownRenderable | CodeRenderable; scroll: ScrollBoxRenderable };

function Harness({ kind, onReady }: { kind: "markdown" | "code"; onReady: (captured: Captured) => void }) {
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const doc = useRef<MarkdownRenderable | CodeRenderable | null>(null);
  const [, force] = useState(0);

  // Refs are populated during the commit, so the first pass can run before both
  // exist; re-render once until they do, then hand them to the test.
  useEffect(() => {
    if (scroll.current && doc.current) onReady({ doc: doc.current, scroll: scroll.current });
    else force((n) => n + 1);
  }, [onReady]);

  return (
    <scrollbox ref={scroll} height={VIEWPORT_HEIGHT} width={60}>
      {kind === "markdown" ? (
        <markdown
          ref={(node) => {
            doc.current = node;
          }}
          width="100%"
          content={markdownSource}
          syntaxStyle={style}
          streaming
          internalBlockMode="top-level"
          tableOptions={{ style: "grid", widthMode: "full", wrapMode: "word" }}
        />
      ) : (
        <code
          ref={(node) => {
            doc.current = node;
          }}
          width="100%"
          content={codeSource}
          filetype="typescript"
          syntaxStyle={style}
          wrapMode="none"
          drawUnstyledText
        />
      )}
    </scrollbox>
  );
}

async function capture(kind: "markdown" | "code") {
  // Resolve through a promise rather than a mutable binding so the renderables
  // arrive already narrowed, with no assertion needed.
  let announce: (captured: Captured) => void = () => undefined;
  const ready = new Promise<Captured>((resolve) => (announce = resolve));

  const setup = await testRender(<Harness kind={kind} onReady={announce} />, { width: 70, height: 24 });
  await setup.renderOnce();
  await setup.flush();
  const { doc, scroll } = await ready;
  return { setup, doc, scroll };
}

/**
 * Jump to `line` the way App does, then report the viewport rows top-to-bottom.
 * `clamped` marks a target the document is too short to bring to the top, where
 * landing anywhere in view is the best possible outcome.
 */
async function jump(
  setup: Awaited<ReturnType<typeof capture>>["setup"],
  doc: MarkdownRenderable | CodeRenderable,
  scroll: ScrollBoxRenderable,
  line: number,
  totalLines: number,
): Promise<{ rows: string[]; clamped: boolean }> {
  const row = scrollRowForLine(doc, scroll, line, totalLines);
  const max = Math.max(0, scroll.scrollHeight - scroll.viewport.height);
  scroll.scrollTo(Math.max(0, Math.min(row, max)));
  await setup.renderOnce();
  await setup.flush();
  const rows = setup
    .captureCharFrame()
    .split("\n")
    .slice(scroll.viewport.y, scroll.viewport.y + scroll.viewport.height)
    .map((text) => text.trim());
  return { rows, clamped: row > max };
}

test("jumping to a heading puts that heading at the top of the viewport", async () => {
  const { setup, doc, scroll } = await capture("markdown");
  try {
    for (const heading of HEADINGS) {
      const line = markdownLines.indexOf(heading);
      const { rows, clamped } = await jump(setup, doc, scroll, line, markdownLines.length);
      const text = heading.replace(/^#+ /, "");

      // Land on the first row, not merely somewhere on screen: the proportional
      // fallback gets close enough to satisfy a weaker "is it visible" check.
      // The trailing heading is the exception, since the document ends before
      // it can be scrolled to the top.
      if (clamped) expect(rows.join("\n")).toContain(text);
      else expect(rows[0]).toContain(text);
    }
  } finally {
    setup.renderer.destroy();
  }
});

test("jumping to a search hit puts that line in view", async () => {
  const { setup, doc, scroll } = await capture("markdown");
  try {
    const line = markdownLines.findIndex((text) => text.includes("UNIQUEMARKER"));
    expect(line).toBeGreaterThan(0);

    const { rows } = await jump(setup, doc, scroll, line, markdownLines.length);
    expect(rows.join("\n")).toContain("UNIQUEMARKER");
  } finally {
    setup.renderer.destroy();
  }
});

test("jumping within a plain code file is line-exact", async () => {
  const { setup, doc, scroll } = await capture("code");
  try {
    for (const line of [0, 10, 40]) {
      const { rows } = await jump(setup, doc, scroll, line, codeLines.length);
      expect(rows[0]).toContain(`const value${line} =`);
    }
  } finally {
    setup.renderer.destroy();
  }
});
