import { describe, expect, mock, test } from "bun:test";
import { copySelection, handleSelectionKey } from "./clipboard.ts";

function renderer(text: string | null, osc52 = true) {
  return {
    getSelection: () => (text === null ? null : { getSelectedText: () => text }),
    copyToClipboardOSC52: mock(() => osc52),
    clearSelection: mock(() => undefined),
  };
}

describe("copySelection", () => {
  test("ignores an empty selection", () => {
    const target = renderer(null);
    const writeNative = mock(async () => true);
    const notify = mock(() => undefined);

    expect(copySelection(target, { writeNative, notify })).toBe(false);
    expect(target.copyToClipboardOSC52).not.toHaveBeenCalled();
    expect(writeNative).not.toHaveBeenCalled();
    expect(target.clearSelection).not.toHaveBeenCalled();
  });

  test("copies through OSC52 and the native clipboard", async () => {
    const target = renderer("selected text");
    const writeNative = mock(async () => true);
    const notify = mock(() => undefined);

    expect(copySelection(target, { writeNative, notify })).toBe(true);
    expect(target.copyToClipboardOSC52).toHaveBeenCalledWith("selected text");
    expect(writeNative).toHaveBeenCalledWith("selected text");
    expect(target.clearSelection).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("copied to clipboard", false);
    await Promise.resolve();
  });

  test("reports native fallback success when OSC52 is unavailable", async () => {
    const target = renderer("fallback", false);
    const writeNative = mock(async () => true);
    const notify = mock(() => undefined);

    expect(copySelection(target, { writeNative, notify })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(notify).toHaveBeenCalledWith("copied to clipboard", false);
  });

  test("reports when no clipboard transport is available", async () => {
    const target = renderer("lost", false);
    const writeNative = mock(async () => false);
    const notify = mock(() => undefined);

    expect(copySelection(target, { writeNative, notify })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(notify).toHaveBeenCalledWith("clipboard unavailable", true);
  });

  test("does not report stale completion from an older selection", async () => {
    let finishFirst: (copied: boolean) => void = () => undefined;
    let finishSecond: (copied: boolean) => void = () => undefined;
    const firstNative = new Promise<boolean>((resolve) => (finishFirst = resolve));
    const secondNative = new Promise<boolean>((resolve) => (finishSecond = resolve));
    const firstNotify = mock(() => undefined);
    const secondNotify = mock(() => undefined);

    copySelection(renderer("first", false), { writeNative: () => firstNative, notify: firstNotify });
    copySelection(renderer("second", false), { writeNative: () => secondNative, notify: secondNotify });
    finishSecond(true);
    await Promise.resolve();
    finishFirst(false);
    await Promise.resolve();

    expect(secondNotify).toHaveBeenCalledWith("copied to clipboard", false);
    expect(firstNotify).not.toHaveBeenCalled();
  });
});

describe("handleSelectionKey", () => {
  test("copies a selection before Ctrl-C can quit the app", () => {
    const target = renderer("keyboard selection");
    const key = { ctrl: true, name: "c", preventDefault: mock(() => undefined), stopPropagation: mock(() => undefined) };

    const handled = handleSelectionKey(target, key, { writeNative: async () => true, notify: () => undefined });

    expect(handled).toBe(true);
    expect(target.copyToClipboardOSC52).toHaveBeenCalledWith("keyboard selection");
    expect(key.preventDefault).toHaveBeenCalledTimes(1);
    expect(key.stopPropagation).toHaveBeenCalledTimes(1);
  });

  test("leaves Ctrl-C available when no text is selected", () => {
    const target = renderer(null);
    const key = { ctrl: true, name: "c", preventDefault: mock(() => undefined), stopPropagation: mock(() => undefined) };

    expect(handleSelectionKey(target, key, { writeNative: async () => true, notify: () => undefined })).toBe(false);
    expect(key.preventDefault).not.toHaveBeenCalled();
  });
});
