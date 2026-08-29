import type { ClipboardWriteOptions, ClipboardWriteResult } from "@opentui/core";
import { errorDetail } from "../domain/model.ts";

interface SelectionRenderer {
  readonly getSelection: () => { readonly getSelectedText: () => string } | null;
  readonly clearSelection: () => void;
}

/**
 * The slice of OpenTUI's ClipboardService this module needs. Narrow so tests
 * can substitute a recorder without a native host clipboard.
 */
export interface SelectionClipboard {
  readonly writeText: (text: string, options: ClipboardWriteOptions) => Promise<ClipboardWriteResult>;
}

interface CopySelectionOptions {
  readonly notify: (message: string, error: boolean) => void;
}

interface SelectionKeyEvent {
  readonly ctrl?: boolean;
  readonly name: string;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}

/**
 * `best-available` writes to the host clipboard first and only falls back to
 * OSC 52 when the host reports `unsupported` or `failed`. That ordering matters:
 * a queued OSC 52 sequence says nothing about whether the terminal accepted it,
 * and an undetected terminal reports its OSC 52 capability as `unknown`, so
 * preferring the terminal path would report success on terminals that silently
 * drop the sequence.
 */
const writeOptions: ClipboardWriteOptions = { destination: "best-available" };

interface CopyOutcome {
  readonly message: string;
  readonly error: boolean;
}

function describe(result: ClipboardWriteResult): CopyOutcome {
  if (result.host.status === "written") return { message: "copied to clipboard", error: false };
  if (result.terminal.status === "attempted") return { message: "copied to clipboard", error: false };
  if (result.host.status === "timed-out") return { message: "clipboard timed out", error: true };
  if (result.host.status === "failed") return { message: `clipboard failed: ${result.host.error.message}`, error: true };
  return { message: "clipboard unavailable", error: true };
}

let latestCopy = 0;

/**
 * Copy the active OpenTUI text selection and clear its highlight. Returns
 * whether a selection existed, synchronously, so key handling can decide
 * immediately whether it consumed the event; the write itself is asynchronous.
 */
export function copySelection(renderer: SelectionRenderer, clipboard: SelectionClipboard, options: CopySelectionOptions): boolean {
  const text = renderer.getSelection()?.getSelectedText();
  if (!text) return false;

  const copy = ++latestCopy;
  renderer.clearSelection();

  void clipboard.writeText(text, writeOptions).then(
    (result) => {
      // A newer selection already reported; do not overwrite its message.
      if (copy !== latestCopy) return;
      const { message, error } = describe(result);
      options.notify(message, error);
    },
    // writeText rejects on invalid text or a payload over maxWriteBytes.
    <Thrown>(error: Thrown) => {
      if (copy !== latestCopy) return;
      options.notify(`clipboard failed: ${errorDetail(error)}`, true);
    },
  );
  return true;
}

/** Let text-selection actions win before application-level key bindings. */
export function handleSelectionKey(renderer: SelectionRenderer, clipboard: SelectionClipboard, key: SelectionKeyEvent, options: CopySelectionOptions): boolean {
  if (key.ctrl && key.name === "c") {
    if (!copySelection(renderer, clipboard, options)) return false;
    key.preventDefault();
    key.stopPropagation();
    return true;
  }
  return false;
}
