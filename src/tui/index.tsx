/** @jsxImportSource @opentui/react */
// Bun resolves tsconfig.json from the *cwd*, so running `slinky` from a project
// that sets its own jsxImportSource (a Vue app, say) would otherwise retarget
// this file's JSX at that project's runtime. Pin it per file.
import { createClipboard, createCliRenderer, createHostClipboard, createRendererClipboardAdapter } from "@opentui/core";
import type { CliRenderer, CliRendererConfig, ClipboardService, HostClipboardService } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/react";
import { createRoot } from "@opentui/react";
import { App } from "./App.tsx";
import { runtime } from "./runtime.ts";

/** Resolve once the renderer has released the terminal, however that happened. */
function untilDestroyed(renderer: CliRenderer): Promise<void> {
  if (renderer.isDestroyed) return Promise.resolve();
  return new Promise((resolve) => renderer.once("destroy", () => resolve()));
}

/**
 * Shared so tests exercise the same renderer contract the binary runs under.
 */
export const rendererOptions = {
  // Ctrl+C is handled as a parsed key so it can copy an active selection
  // instead of quitting. Drop SIGINT too, otherwise the signal path would
  // still tear the renderer down behind that handler's back.
  exitOnCtrlC: false,
  exitSignals: ["SIGTERM", "SIGQUIT", "SIGABRT", "SIGHUP", "SIGBREAK", "SIGPIPE", "SIGBUS"],
  // App drives every pane from one global key handler. With autofocus on, a
  // click also focuses the ScrollBox, which then applies its own arrow, page
  // and home/end bindings after ours and moves the document twice per press.
  autoFocus: false,
} as const satisfies CliRendererConfig;

export async function runTui(): Promise<void> {
  const renderer = await createCliRenderer({
    ...rendererOptions,
    screenMode: "alternate-screen",
  });

  // createHostClipboard() owns a native backend; createClipboard() adopts it and
  // disposes it. Track the host separately so a failure between the two calls
  // still releases something.
  let host: HostClipboardService | undefined;
  let clipboard: ClipboardService | undefined;

  try {
    host = createHostClipboard();
    clipboard = createClipboard({ host, terminal: createRendererClipboardAdapter(renderer) });
    host = undefined; // createClipboard() owns it from here.

    const root = createRoot(renderer);
    const keymap = createDefaultOpenTuiKeymap(renderer);
    root.render(
      <KeymapProvider keymap={keymap}>
        <App clipboard={clipboard} />
      </KeymapProvider>,
    );

    // render() returns as soon as the tree mounts, so hold the process here
    // until something destroys the renderer. Quitting, a signal, and a crash
    // all converge on this promise.
    await untilDestroyed(renderer);
  } finally {
    try {
      // Clipboard disposal is asynchronous and must finish before exit: on
      // Linux this process can own the selection, and pasting elsewhere reads
      // it back from us.
      if (clipboard) await clipboard.dispose();
      else if (host) await host.dispose();
    } finally {
      try {
        await runtime.dispose();
      } finally {
        // Idempotent, and the only path that restores the terminal when the
        // React tree threw before anything destroyed the renderer.
        renderer.destroy();
      }
    }
  }
}
