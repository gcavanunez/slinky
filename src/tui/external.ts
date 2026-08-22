import { spawnSync } from "node:child_process";
import type { EditorCommand } from "../lib/editor.ts";

export interface SuspendableRenderer {
  readonly suspend: () => void;
  readonly resume: () => void;
}

interface EditorResult {
  readonly error?: Error;
  readonly status: number | null;
}

export type EditorSpawner = (command: string, args: ReadonlyArray<string>, options: { readonly cwd: string; readonly stdio: "inherit" }) => EditorResult;

export function editableHostSkillPath(
  hasSkillContext: boolean,
  managed: { readonly origin: "local" | "vendor"; readonly path: string } | undefined,
  unindexed: { readonly origin: "local" | "vendor" | "agent"; readonly path: string } | undefined,
): string | null {
  if (!hasSkillContext) return null;
  if (managed?.origin === "local") return managed.path;
  return unindexed?.origin === "local" ? unindexed.path : null;
}

export function withSuspendedRenderer<A>(renderer: SuspendableRenderer, action: () => A): A {
  renderer.suspend();
  try {
    return action();
  } finally {
    renderer.resume();
  }
}

export function editSkillInEditor(
  editor: EditorCommand,
  repo: string,
  skillPath: string,
  spawn: EditorSpawner = (command, args, options) => spawnSync(command, [...args], options),
): void {
  const [command, ...args] = editor;
  const result = spawn(command, [...args, skillPath], { cwd: repo, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? "unknown"}`);
}
