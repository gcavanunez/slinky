import { describe, expect, mock, test } from "bun:test";
import type { ClipboardWriteResult } from "@opentui/core";
import { copySelection, handleSelectionKey } from "./clipboard.ts";
import type { SelectionClipboard } from "./clipboard.ts";

function renderer(text: string | null) {
  return {
    getSelection: () => (text === null ? null : { getSelectedText: () => text }),
    clearSelection: mock(() => undefined),
  };
}

const wrote: ClipboardWriteResult = {
  host: { status: "written" },
  terminal: { status: "not-attempted", capability: "unknown" },
};

const terminalOnly: ClipboardWriteResult = {
  host: { status: "unsupported" },
  terminal: { status: "attempted", capability: "supported" },
};

const nowhere: ClipboardWriteResult = {
  host: { status: "unsupported" },
  terminal: { status: "local-failure", capability: "unsupported" },
};

function clipboard(result: ClipboardWriteResult | Promise<ClipboardWriteResult>): SelectionClipboard & { writeText: ReturnType<typeof mock> } {
  return { writeText: mock(async () => await result) };
}

describe("copySelection", () => {
  test("ignores an empty selection", () => {
    const target = renderer(null);
    const board = clipboard(wrote);
    const notify = mock(() => undefined);

    expect(copySelection(target, board, { notify })).toBe(false);
    expect(board.writeText).not.toHaveBeenCalled();
    expect(target.clearSelection).not.toHaveBeenCalled();
  });

  test("writes host-first so an undetected terminal cannot claim a false success", async () => {
    const target = renderer("selected text");
    const board = clipboard(wrote);
    const notify = mock(() => undefined);

    expect(copySelection(target, board, { notify })).toBe(true);
    expect(board.writeText).toHaveBeenCalledWith("selected text", { destination: "best-available" });
    expect(target.clearSelection).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledWith("copied to clipboard", false);
  });

  test("counts an OSC 52 fallback as copied", async () => {
    const notify = mock(() => undefined);
    copySelection(renderer("fallback"), clipboard(terminalOnly), { notify });

    await Promise.resolve();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledWith("copied to clipboard", false);
  });

  test("reports when no clipboard transport is available", async () => {
    const notify = mock(() => undefined);
    copySelection(renderer("lost"), clipboard(nowhere), { notify });

    await Promise.resolve();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledWith("clipboard unavailable", true);
  });

  test("surfaces a rejected write instead of reporting success", async () => {
    const notify = mock(() => undefined);
    copySelection(renderer("too big"), { writeText: () => Promise.reject(new RangeError("text exceeds maxWriteBytes")) }, { notify });

    await Promise.resolve();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledWith("clipboard failed: text exceeds maxWriteBytes", true);
  });

  test("does not report stale completion from an older selection", async () => {
    let finishFirst: (result: ClipboardWriteResult) => void = () => undefined;
    let finishSecond: (result: ClipboardWriteResult) => void = () => undefined;
    const first = new Promise<ClipboardWriteResult>((resolve) => (finishFirst = resolve));
    const second = new Promise<ClipboardWriteResult>((resolve) => (finishSecond = resolve));
    const firstNotify = mock(() => undefined);
    const secondNotify = mock(() => undefined);

    copySelection(renderer("first"), { writeText: () => first }, { notify: firstNotify });
    copySelection(renderer("second"), { writeText: () => second }, { notify: secondNotify });
    finishSecond(wrote);
    await Promise.resolve();
    finishFirst(nowhere);
    await Promise.resolve();

    expect(secondNotify).toHaveBeenCalledWith("copied to clipboard", false);
    expect(firstNotify).not.toHaveBeenCalled();
  });
});

describe("handleSelectionKey", () => {
  test("copies a selection before Ctrl-C can quit the app", () => {
    const target = renderer("keyboard selection");
    const board = clipboard(wrote);
    const key = { ctrl: true, name: "c", preventDefault: mock(() => undefined), stopPropagation: mock(() => undefined) };

    expect(handleSelectionKey(target, board, key, { notify: () => undefined })).toBe(true);
    expect(board.writeText).toHaveBeenCalledWith("keyboard selection", { destination: "best-available" });
    expect(key.preventDefault).toHaveBeenCalledTimes(1);
    expect(key.stopPropagation).toHaveBeenCalledTimes(1);
  });

  test("leaves Ctrl-C available when no text is selected", () => {
    const target = renderer(null);
    const key = { ctrl: true, name: "c", preventDefault: mock(() => undefined), stopPropagation: mock(() => undefined) };

    expect(handleSelectionKey(target, clipboard(wrote), key, { notify: () => undefined })).toBe(false);
    expect(key.preventDefault).not.toHaveBeenCalled();
  });
});
