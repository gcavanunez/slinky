/** @jsxImportSource @opentui/react */
// Bun resolves tsconfig.json from the *cwd*, so running `slinky` from a project
// that sets its own jsxImportSource (a Vue app, say) would otherwise retarget
// this file's JSX at that project's runtime. Pin it per file.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.tsx";

export async function runTui(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    onDestroy: () => {
      process.exit(0);
    },
  });
  createRoot(renderer).render(<App />);
}
