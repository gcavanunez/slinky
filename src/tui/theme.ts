import { SyntaxStyle } from "@opentui/core";

export const colors = {
  text: "#c9c7cd",
  muted: "#6c6a72",
  accent: "#8fb4ff",
  green: "#8ccf7e",
  yellow: "#e5c76b",
  red: "#e55561",
  selectedBg: "#2a2f3a",
  selectedText: "#ffffff",
  headerBg: "#1c1f26",
  modalBorder: "#4a5164",
  panelBg: "#16191f",
  code: "#d9a6ff",
  cyan: "#67cbe7",
  orange: "#e6a56b",
} as const;

export function createMarkdownSyntax(): SyntaxStyle {
  return SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: colors.text } },
    { scope: ["comment", "comment.documentation"], style: { foreground: colors.muted, italic: true } },
    { scope: ["string", "symbol", "character"], style: { foreground: colors.green } },
    { scope: ["number", "boolean", "constant"], style: { foreground: colors.orange } },
    { scope: ["keyword", "keyword.return", "keyword.conditional", "keyword.repeat"], style: { foreground: colors.code, italic: true } },
    { scope: ["function", "function.call", "function.method", "constructor"], style: { foreground: colors.accent } },
    { scope: ["type", "class", "module", "type.builtin"], style: { foreground: colors.cyan } },
    { scope: ["variable", "variable.parameter", "property", "field"], style: { foreground: colors.text } },
    { scope: ["operator", "keyword.operator", "punctuation", "punctuation.bracket", "punctuation.delimiter"], style: { foreground: colors.muted } },
    { scope: ["markup.heading", "markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"], style: { foreground: colors.accent, bold: true } },
    { scope: ["markup.heading.1"], style: { foreground: colors.accent, bold: true, underline: true } },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: colors.text, bold: true } },
    { scope: ["markup.italic", "markup.quote"], style: { foreground: colors.muted, italic: true } },
    { scope: ["markup.list"], style: { foreground: colors.yellow } },
    { scope: ["markup.list.checked"], style: { foreground: colors.green } },
    { scope: ["markup.list.unchecked"], style: { foreground: colors.muted } },
    { scope: ["markup.raw", "markup.raw.block", "markup.raw.inline"], style: { foreground: colors.code } },
    { scope: ["markup.link", "markup.link.label", "markup.link.url", "string.special.url"], style: { foreground: colors.cyan, underline: true } },
    { scope: ["conceal"], style: { foreground: colors.muted } },
    { scope: ["diff.plus"], style: { foreground: colors.green } },
    { scope: ["diff.minus"], style: { foreground: colors.red } },
    { scope: ["diff.delta"], style: { foreground: colors.yellow } },
  ]);
}
