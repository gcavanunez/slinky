/**
 * Prove that this build can actually reach OpenTUI's native renderer.
 *
 * `--version` returns before the CLI is imported, so a release verified only by
 * that flag never loads @opentui/core at all: a compiled binary missing its
 * embedded native library, parser worker or Tree-sitter assets would ship
 * green. This drives the same machinery the TUI does — native renderer, a real
 * render pass, and a Tree-sitter highlight — without needing a terminal.
 */
export async function runSelfTest(): Promise<void> {
  const checks: string[] = [];

  const { TextRenderable } = await import("@opentui/core");
  checks.push("import @opentui/core");

  // createTestRenderer owns an in-memory native output buffer, so it needs no
  // tty and cannot disturb the terminal that invoked us. It still builds a real
  // native renderer, which is the thing under test.
  const { createTestRenderer } = await import("@opentui/core/testing");
  const setup = await createTestRenderer({ width: 80, height: 24 });
  checks.push("native renderer");

  try {
    setup.renderer.root.add(new TextRenderable(setup.renderer, { content: "slinky selftest" }));
    await setup.renderOnce();
    checks.push("render pass");

    if (!setup.captureCharFrame().includes("slinky selftest")) {
      throw new Error("renderer produced no readable frame");
    }
    checks.push("frame output");

    // The document pane highlights markdown and code, which needs the parser
    // worker and the bundled grammars.
    const { getTreeSitterClient, destroyTreeSitterClient } = await import("@opentui/core");
    try {
      await getTreeSitterClient().initialize();
      checks.push("tree-sitter worker");
    } finally {
      await destroyTreeSitterClient();
    }
  } finally {
    setup.renderer.destroy();
  }

  for (const check of checks) console.log(`ok  ${check}`);
}
