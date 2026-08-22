import { describe, expect, test } from "bun:test";
import { defaultEditor, parseCommand, resolveEditor } from "./editor.ts";

describe("parseCommand", () => {
  test("splits a bare command and its flags", () => {
    expect(parseCommand("nvim")).toEqual(["nvim"]);
    expect(parseCommand("code -w")).toEqual(["code", "-w"]);
    expect(parseCommand("emacsclient -nw -a ''")).toEqual(["emacsclient", "-nw", "-a", ""]);
  });

  test("keeps quoted spans together so paths with spaces survive", () => {
    expect(parseCommand('"/Applications/My Editor" --wait')).toEqual(["/Applications/My Editor", "--wait"]);
    expect(parseCommand("'/opt/my editor/bin/ed' -f")).toEqual(["/opt/my editor/bin/ed", "-f"]);
  });

  test("collapses surrounding and repeated whitespace", () => {
    expect(parseCommand("   code    -w  ")).toEqual(["code", "-w"]);
    expect(parseCommand("")).toEqual([]);
    expect(parseCommand("   ")).toEqual([]);
  });
});

describe("resolveEditor", () => {
  test("prefers the configured editor over the environment", () => {
    expect(resolveEditor({ configured: "code -w", visual: "vim", env: "nano" })).toEqual(["code", "-w"]);
  });

  test("falls back through $VISUAL then $EDITOR", () => {
    expect(resolveEditor({ visual: "vim", env: "nano" })).toEqual(["vim"]);
    expect(resolveEditor({ env: "nano" })).toEqual(["nano"]);
  });

  test("uses the default when nothing is set", () => {
    expect(resolveEditor({})).toEqual([defaultEditor]);
  });

  test("skips a source that parses to nothing", () => {
    expect(resolveEditor({ configured: "   ", visual: "vim" })).toEqual(["vim"]);
    expect(resolveEditor({ configured: "   " })).toEqual([defaultEditor]);
  });
});
