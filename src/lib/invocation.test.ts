import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { invocationInfo, renderInvocation, undecorate } from "./invocation.ts";

describe("OpenCode invocation rendering", () => {
  test("inherits native metadata before translating the portable manual-only flag", () => {
    const text = "---\nname: review\ndisable-model-invocation: true\nmetadata: {opencode/autoinvoke: true, owner: team}\n---\nBody\n";
    expect(invocationInfo(text)).toEqual({ automatic: true, source: "upstream" });
    expect(renderInvocation(text).text).toBe(text);
    const manual = renderInvocation(text, false);
    expect(manual.info).toEqual({ automatic: false, source: "host" });
    expect(manual.text).toContain("owner: team");
    expect(undecorate(manual.text, { ...manual.receipt!, source: "/catalog/review" })).toBe(text);
  });

  test("translates manual-only skills and preserves the exact body and original header", () => {
    const text = "---\r\nname: foo\r\ndescription: |\r\n  Line one\r\n  Line two\r\ndisable-model-invocation: true\r\n---\r\n# Body\r\n---\r\n";
    const rendered = renderInvocation(text);
    expect(rendered.info).toEqual({ automatic: false, source: "compatibility" });
    expect(rendered.text.endsWith("# Body\r\n---\r\n")).toBe(true);
    expect(rendered.text).toContain("opencode/autoinvoke: false");
    expect(undecorate(rendered.text, { ...rendered.receipt!, source: "/foo" })).toBe(text);
  });

  test("adds frontmatter to a plain skill without losing its first line", () => {
    const text = "# Plain skill\n";
    expect(renderInvocation(text).text).toBe(text);
    const rendered = renderInvocation(text, false);
    expect(rendered.text).toContain("opencode/autoinvoke: false");
    expect(undecorate(rendered.text, { ...rendered.receipt!, source: "/foo" })).toBe(text);
  });

  test("merges an empty frontmatter block without turning the old delimiters into body text", () => {
    const text = "---\n---\n# Body\n";
    const rendered = renderInvocation(text, false);
    expect(rendered.text).toBe("---\nmetadata:\n  opencode/autoinvoke: false # slinky:autoinvoke\n---\n# Body\n");
    expect(undecorate(rendered.text, { ...rendered.receipt!, source: "/foo" })).toBe(text);
  });

  test("preserves author edits alongside the managed field while removing only the addition", () => {
    const text = "---\nname: foo\nmetadata:\n  owner: original\n---\nOld body\n";
    const rendered = renderInvocation(text, false);
    const edited = rendered.text.replace("owner: original", "owner: updated").replace("Old body", "New body");
    const source = undecorate(edited, { ...rendered.receipt!, source: "/foo" });
    expect(source).toContain("owner: updated");
    expect(source).toContain("New body");
    expect(source).not.toContain("opencode/autoinvoke");
  });

  test("fresh upstream metadata is not stripped by an old receipt", () => {
    const rendered = renderInvocation("---\nname: foo\n---\nOld\n", false);
    const upstream = "---\nname: foo\nmetadata:\n  opencode/autoinvoke: false\n---\nNew\n";
    expect(undecorate(upstream, { ...rendered.receipt!, source: "/foo" })).toBe(upstream);
  });

  test("an explicit host preference overrides native string booleans without losing metadata", () => {
    const text = '---\nname: foo\nmetadata:\n  opencode/autoinvoke: "false"\n  extra: [a, b]\n---\nBody\n';
    const rendered = renderInvocation(text, true);
    const header = rendered.text.split("---")[1]!;
    expect(parse(header).metadata).toEqual({ "opencode/autoinvoke": true, extra: ["a", "b"] });
    expect(undecorate(rendered.text, { ...rendered.receipt!, source: "/foo" })).toBe(text);
  });

  test("refuses to interpret broken YAML or overwrite non-mapping metadata", () => {
    expect(() => renderInvocation("---\nmetadata: [broken\n---\nBody", false)).toThrow("invalid skill frontmatter");
    expect(() => renderInvocation("---\nmetadata: scalar\n---\nBody", false)).toThrow("metadata must be a YAML mapping");
  });

  test("missing receipts and direct edits to the owned setting fail explicitly", () => {
    const rendered = renderInvocation("# Skill", false);
    expect(() => undecorate(rendered.text)).toThrow("no receipt");
    expect(() => undecorate(rendered.text.replace("false", "true"), { ...rendered.receipt!, source: "/foo" })).toThrow("metadata was edited");
  });
});
