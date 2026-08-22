/** The editor used when nothing is configured and neither $VISUAL nor $EDITOR is set. */
export const defaultEditor = "nvim";

export type EditorCommand = readonly [string, ...string[]];

/**
 * Split a command spec into argv, honouring single and double quotes.
 *
 * Editor specs routinely carry flags (`code -w`, `emacsclient -nw`) and sometimes live at a path
 * with spaces. Tokenising here means the command can be spawned directly: no shell is involved, so
 * a skill path can never be interpreted as shell syntax.
 */
export function parseCommand(spec: string): string[] {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const char of spec) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n") {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) argv.push(current);
  return argv;
}

export interface EditorSources {
  /** `editor` from ~/.config/slinky/config.json. */
  readonly configured?: string | undefined;
  readonly visual?: string | undefined;
  readonly env?: string | undefined;
}

/** Resolve the editor to spawn: configured value, then $VISUAL, then $EDITOR, then the default. */
export function resolveEditor(sources: EditorSources): EditorCommand {
  for (const spec of [sources.configured, sources.visual, sources.env]) {
    if (spec === undefined) continue;
    const [command, ...args] = parseCommand(spec);
    if (command !== undefined) return [command, ...args];
  }
  return [defaultEditor];
}
