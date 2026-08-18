import { spawn } from "node:child_process";
import { platform, release } from "node:os";

interface SelectionRenderer {
  readonly getSelection: () => { readonly getSelectedText: () => string } | null;
  readonly copyToClipboardOSC52: (text: string) => boolean;
  readonly clearSelection: () => void;
}

interface CopySelectionOptions {
  readonly notify: (message: string, error: boolean) => void;
  readonly writeNative?: (text: string) => Promise<boolean>;
}

interface SelectionKeyEvent {
  readonly ctrl?: boolean;
  readonly name: string;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}

function runClipboardCommand(command: string, args: ReadonlyArray<string>, input: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (copied: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(copied);
    };
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5000);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(input);
  });
}

async function writeNativeClipboardNow(text: string): Promise<boolean> {
  const os = platform();
  const commands: Array<readonly [string, ...string[]]> = [];
  if (os === "darwin") commands.push(["pbcopy"]);
  if (os === "linux") {
    if (process.env.WAYLAND_DISPLAY) commands.push(["wl-copy"]);
    commands.push(["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]);
  }
  if (os === "win32" || release().toLowerCase().includes("microsoft")) {
    commands.push([
      "powershell.exe",
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ]);
  }

  for (const [command, ...args] of commands) {
    if (await runClipboardCommand(command, args, text)) return true;
  }
  return false;
}

let nativeWriteQueue = Promise.resolve();

/** Copy natively in selection order so an older process cannot overwrite a newer selection. */
export function writeNativeClipboard(text: string): Promise<boolean> {
  const result = nativeWriteQueue.then(() => writeNativeClipboardNow(text));
  nativeWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

let latestCopy = 0;

/** Copy the active OpenTUI text selection and clear its highlight. */
export function copySelection(renderer: SelectionRenderer, options: CopySelectionOptions): boolean {
  const text = renderer.getSelection()?.getSelectedText();
  if (!text) return false;
  const copy = ++latestCopy;

  let osc52 = false;
  try {
    osc52 = renderer.copyToClipboardOSC52(text);
  } catch {
    // Native clipboard utilities remain available when terminal capability detection fails.
  }

  let native: Promise<boolean>;
  try {
    native = (options.writeNative ?? writeNativeClipboard)(text);
  } catch {
    native = Promise.resolve(false);
  }
  renderer.clearSelection();

  if (osc52) options.notify("copied to clipboard", false);
  else {
    void native.then(
      (copied) => {
        if (copy === latestCopy) options.notify(copied ? "copied to clipboard" : "clipboard unavailable", !copied);
      },
      () => {
        if (copy === latestCopy) options.notify("clipboard unavailable", true);
      },
    );
  }
  return true;
}

/** Let text-selection actions win before application-level key bindings. */
export function handleSelectionKey(renderer: SelectionRenderer, key: SelectionKeyEvent, options: CopySelectionOptions): boolean {
  if (key.ctrl && key.name === "c") {
    if (!copySelection(renderer, options)) return false;
    key.preventDefault();
    key.stopPropagation();
    return true;
  }
  return false;
}
