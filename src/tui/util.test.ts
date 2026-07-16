import { describe, expect, test } from "bun:test";
import { fitCell, printable, windowOf } from "./util.ts";

describe("fitCell", () => {
  test("pads to width", () => {
    expect(fitCell("ab", 5)).toBe("ab   ");
    expect(fitCell("ab", 5, "right")).toBe("   ab");
  });
  test("truncates with ellipsis", () => {
    expect(fitCell("abcdef", 4)).toBe("abc\u2026");
  });
  test("zero width", () => {
    expect(fitCell("abc", 0)).toBe("");
  });
});

describe("windowOf", () => {
  test("no scroll when everything fits", () => {
    expect(windowOf(0, 5, 8, 10)).toBe(0);
  });
  test("follows selection below the window", () => {
    expect(windowOf(0, 12, 50, 10)).toBe(3);
  });
  test("follows selection above the window", () => {
    expect(windowOf(20, 5, 50, 10)).toBe(5);
  });
  test("clamps to end", () => {
    expect(windowOf(45, 49, 50, 10)).toBe(40);
  });
});

describe("printable", () => {
  test("single char", () => {
    expect(printable({ name: "a", sequence: "a", ctrl: false, meta: false })).toBe("a");
  });
  test("space keyword", () => {
    expect(printable({ name: "space", sequence: " ", ctrl: false, meta: false })).toBe(" ");
  });
  test("ctrl chords ignored", () => {
    expect(printable({ name: "c", sequence: "\u0003", ctrl: true, meta: false })).toBe("");
  });
  test("escape sequences ignored", () => {
    expect(printable({ name: "up", sequence: "\u001b[A", ctrl: false, meta: false })).toBe("");
  });
  test("paste via sequence", () => {
    expect(printable({ name: "", sequence: "/home/x", ctrl: false, meta: false })).toBe("/home/x");
  });
});
