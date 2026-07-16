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
