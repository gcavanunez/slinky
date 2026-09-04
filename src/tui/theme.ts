import { SyntaxStyle } from "@opentui/core";
import { defaultThemeId, themeIds } from "../domain/model.ts";
import type { ThemeId } from "../domain/model.ts";

export interface ColorPalette {
  /** Whole-screen background. */
  readonly background: string;
  /** Overlay background, one step lighter than the screen. */
  readonly modalBackground: string;
  readonly text: string;
  /** Secondary labels: descriptions, dates, hint labels. */
  readonly muted: string;
  /** Rails, dividers, frames, disabled hints. */
  readonly separator: string;
  /** Titles, active tab, focused pane, search prompt. */
  readonly accent: string;
  /** Key names in hints, identifiers, counts. */
  readonly count: string;
  readonly link: string;
  readonly inlineCode: string;
  readonly error: string;
  readonly selectedBg: string;
  readonly selectedText: string;
  readonly green: string;
  readonly yellow: string;
  readonly red: string;
}

export type ThemeTone = "dark" | "light";

export interface ThemeDefinition {
  readonly name: string;
  readonly description: string;
  readonly tone: ThemeTone;
  readonly colors: ColorPalette;
}

// Palettes adapted from ghui (MIT, Kit Langton).
export const themes = {
  slinky: {
    name: "Slinky",
    description: "Warm parchment accents on a deep slate background",
    tone: "dark",
    colors: {
      background: "#111018",
      modalBackground: "#1a1a2e",
      text: "#ede7da",
      muted: "#9f9788",
      separator: "#6f685d",
      accent: "#f4a51c",
      count: "#d7c5a1",
      link: "#7fb4ca",
      inlineCode: "#d7c5a1",
      error: "#f97316",
      selectedBg: "#1d2430",
      selectedText: "#f8fafc",
      green: "#7dd3a3",
      yellow: "#f59e0b",
      red: "#f87171",
    },
  },
  "tokyo-night": {
    name: "Tokyo Night",
    description: "Cool indigo surfaces with neon editor accents",
    tone: "dark",
    colors: {
      background: "#1a1b26",
      modalBackground: "#24283b",
      text: "#c0caf5",
      muted: "#787c99",
      separator: "#3b4261",
      accent: "#7aa2f7",
      count: "#ff9e64",
      link: "#7dcfff",
      inlineCode: "#bb9af7",
      error: "#f7768e",
      selectedBg: "#283457",
      selectedText: "#ffffff",
      green: "#9ece6a",
      yellow: "#e0af68",
      red: "#f7768e",
    },
  },
  // folke/tokyonight.nvim storm.lua: bg, bg_visual, fg, comment, fg_gutter, blue, orange,
  // cyan, magenta, red, green, yellow. modalBackground is the #2d3149 float bg the nvim
  // config gives Telescope prompts and Floaterm.
  "tokyo-night-storm": {
    name: "Tokyo Night Storm",
    description: "Lighter slate-blue Tokyo Night, matching tokyonight-storm in nvim",
    tone: "dark",
    colors: {
      background: "#24283b",
      modalBackground: "#2d3149",
      text: "#c0caf5",
      muted: "#565f89",
      separator: "#3b4261",
      accent: "#7aa2f7",
      count: "#ff9e64",
      link: "#7dcfff",
      inlineCode: "#bb9af7",
      error: "#f7768e",
      selectedBg: "#2e3c64",
      selectedText: "#ffffff",
      green: "#9ece6a",
      yellow: "#e0af68",
      red: "#f7768e",
    },
  },
  catppuccin: {
    name: "Catppuccin",
    description: "Mocha lavender, peach, and soft pastel contrast",
    tone: "dark",
    colors: {
      background: "#1e1e2e",
      modalBackground: "#313244",
      text: "#cdd6f4",
      muted: "#7f849c",
      separator: "#45475a",
      accent: "#cba6f7",
      count: "#fab387",
      link: "#89b4fa",
      inlineCode: "#f5c2e7",
      error: "#f38ba8",
      selectedBg: "#45475a",
      selectedText: "#f5e0dc",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      red: "#f38ba8",
    },
  },
  "catppuccin-latte": {
    name: "Catppuccin Latte",
    description: "Light frothy cream with pastel lavender and peach",
    tone: "light",
    colors: {
      background: "#eff1f5",
      modalBackground: "#e6e9ef",
      text: "#4c4f69",
      muted: "#8c8fa1",
      separator: "#ccd0da",
      accent: "#8839ef",
      count: "#fe640b",
      link: "#1e66f5",
      inlineCode: "#ea76cb",
      error: "#d20f39",
      selectedBg: "#dce0e8",
      selectedText: "#4c4f69",
      green: "#40a02b",
      yellow: "#df8e1d",
      red: "#d20f39",
    },
  },
  "rose-pine": {
    name: "Rose Pine",
    description: "Muted rose, pine, and gold on dusky violet",
    tone: "dark",
    colors: {
      background: "#191724",
      modalBackground: "#26233a",
      text: "#e0def4",
      muted: "#908caa",
      separator: "#524f67",
      accent: "#c4a7e7",
      count: "#ebbcba",
      link: "#9ccfd8",
      inlineCode: "#f6c177",
      error: "#eb6f92",
      selectedBg: "#403d52",
      selectedText: "#f6f1ff",
      green: "#9ccfd8",
      yellow: "#f6c177",
      red: "#eb6f92",
    },
  },
  "rose-pine-dawn": {
    name: "Rose Pine Dawn",
    description: "Soft morning light with rose and sage accents",
    tone: "light",
    colors: {
      background: "#faf4ed",
      modalBackground: "#f2e9e1",
      text: "#575279",
      muted: "#9893a5",
      separator: "#d5c6d3",
      accent: "#907aa9",
      count: "#d7827a",
      link: "#56949f",
      inlineCode: "#ea9d34",
      error: "#b4637a",
      selectedBg: "#e6dfdb",
      selectedText: "#575279",
      green: "#56949f",
      yellow: "#ea9d34",
      red: "#b4637a",
    },
  },
  gruvbox: {
    name: "Gruvbox",
    description: "Retro warm earth tones with punchy semantic accents",
    tone: "dark",
    colors: {
      background: "#282828",
      modalBackground: "#3c3836",
      text: "#ebdbb2",
      muted: "#928374",
      separator: "#665c54",
      accent: "#fabd2f",
      count: "#fe8019",
      link: "#83a598",
      inlineCode: "#d3869b",
      error: "#fb4934",
      selectedBg: "#504945",
      selectedText: "#fbf1c7",
      green: "#b8bb26",
      yellow: "#fabd2f",
      red: "#fb4934",
    },
  },
  "gruvbox-light": {
    name: "Gruvbox Light",
    description: "Warm parchment background with earthy retro colors",
    tone: "light",
    colors: {
      background: "#fbf1c7",
      modalBackground: "#ebdbb2",
      text: "#3c3836",
      muted: "#928374",
      separator: "#d5c4a1",
      accent: "#b57614",
      count: "#af3a03",
      link: "#076678",
      inlineCode: "#8f3f71",
      error: "#cc241d",
      selectedBg: "#d5c4a1",
      selectedText: "#3c3836",
      green: "#79740e",
      yellow: "#b57614",
      red: "#cc241d",
    },
  },
  nord: {
    name: "Nord",
    description: "Arctic blue-gray surfaces with frosty accents",
    tone: "dark",
    colors: {
      background: "#2e3440",
      modalBackground: "#3b4252",
      text: "#eceff4",
      muted: "#8892a7",
      separator: "#4c566a",
      accent: "#88c0d0",
      count: "#ebcb8b",
      link: "#81a1c1",
      inlineCode: "#b48ead",
      error: "#bf616a",
      selectedBg: "#434c5e",
      selectedText: "#eceff4",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      red: "#bf616a",
    },
  },
  dracula: {
    name: "Dracula",
    description: "High-contrast purple, pink, cyan, and green",
    tone: "dark",
    colors: {
      background: "#282a36",
      modalBackground: "#343746",
      text: "#f8f8f2",
      muted: "#8f94b8",
      separator: "#4f5268",
      accent: "#bd93f9",
      count: "#ffb86c",
      link: "#8be9fd",
      inlineCode: "#ff79c6",
      error: "#ff5555",
      selectedBg: "#44475a",
      selectedText: "#f8f8f2",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      red: "#ff5555",
    },
  },
  kanagawa: {
    name: "Kanagawa",
    description: "Ink-wash indigo, wave blues, and autumn accents",
    tone: "dark",
    colors: {
      background: "#1f1f28",
      modalBackground: "#2a2a37",
      text: "#dcd7ba",
      muted: "#727169",
      separator: "#54546d",
      accent: "#7e9cd8",
      count: "#ffa066",
      link: "#7fb4ca",
      inlineCode: "#d27e99",
      error: "#c34043",
      selectedBg: "#363646",
      selectedText: "#fff7d6",
      green: "#76946a",
      yellow: "#c0a36e",
      red: "#c34043",
    },
  },
  "one-dark": {
    name: "One Dark",
    description: "Atom-style charcoal with clean blue and green accents",
    tone: "dark",
    colors: {
      background: "#282c34",
      modalBackground: "#2c313c",
      text: "#abb2bf",
      muted: "#7f848e",
      separator: "#4b5263",
      accent: "#61afef",
      count: "#d19a66",
      link: "#56b6c2",
      inlineCode: "#c678dd",
      error: "#e06c75",
      selectedBg: "#3e4451",
      selectedText: "#ffffff",
      green: "#98c379",
      yellow: "#e5c07b",
      red: "#e06c75",
    },
  },
  "one-light": {
    name: "One Light",
    description: "Clean light surfaces with balanced blue and green accents",
    tone: "light",
    colors: {
      background: "#fafafa",
      modalBackground: "#f0f0f0",
      text: "#383a42",
      muted: "#a0a1a7",
      separator: "#d5d5d5",
      accent: "#4078f2",
      count: "#c18401",
      link: "#0184bc",
      inlineCode: "#a626a4",
      error: "#e45649",
      selectedBg: "#e5e5e6",
      selectedText: "#383a42",
      green: "#50a14f",
      yellow: "#c18401",
      red: "#e45649",
    },
  },
  monokai: {
    name: "Monokai",
    description: "Classic dark olive with electric syntax colors",
    tone: "dark",
    colors: {
      background: "#272822",
      modalBackground: "#383830",
      text: "#f8f8f2",
      muted: "#90908a",
      separator: "#5b5b50",
      accent: "#66d9ef",
      count: "#fd971f",
      link: "#66d9ef",
      inlineCode: "#ae81ff",
      error: "#f92672",
      selectedBg: "#49483e",
      selectedText: "#ffffff",
      green: "#a6e22e",
      yellow: "#e6db74",
      red: "#f92672",
    },
  },
  "solarized-dark": {
    name: "Solarized Dark",
    description: "Low-contrast blue-green base with calibrated accents",
    tone: "dark",
    colors: {
      background: "#002b36",
      modalBackground: "#123d48",
      text: "#eee8d5",
      muted: "#839496",
      separator: "#586e75",
      accent: "#268bd2",
      count: "#cb4b16",
      link: "#268bd2",
      inlineCode: "#2aa198",
      error: "#dc322f",
      selectedBg: "#174652",
      selectedText: "#fdf6e3",
      green: "#859900",
      yellow: "#b58900",
      red: "#dc322f",
    },
  },
  "solarized-light": {
    name: "Solarized Light",
    description: "Warm beige base with the same calibrated accent colors",
    tone: "light",
    colors: {
      background: "#fdf6e3",
      modalBackground: "#eee8d5",
      text: "#657b83",
      muted: "#93a1a1",
      separator: "#d5cdb8",
      accent: "#268bd2",
      count: "#cb4b16",
      link: "#268bd2",
      inlineCode: "#2aa198",
      error: "#dc322f",
      selectedBg: "#e4ddc9",
      selectedText: "#073642",
      green: "#859900",
      yellow: "#b58900",
      red: "#dc322f",
    },
  },
  everforest: {
    name: "Everforest",
    description: "Soft green-gray forest tones with warm highlights",
    tone: "dark",
    colors: {
      background: "#2d353b",
      modalBackground: "#343f44",
      text: "#d3c6aa",
      muted: "#859289",
      separator: "#56635f",
      accent: "#7fbbb3",
      count: "#e69875",
      link: "#7fbbb3",
      inlineCode: "#d699b6",
      error: "#e67e80",
      selectedBg: "#465258",
      selectedText: "#fff4d6",
      green: "#a7c080",
      yellow: "#dbbc7f",
      red: "#e67e80",
    },
  },
  vesper: {
    name: "Vesper",
    description: "Minimal black surfaces with peach and aqua accents",
    tone: "dark",
    colors: {
      background: "#101010",
      modalBackground: "#1A1A1A",
      text: "#FFFFFF",
      muted: "#A0A0A0",
      separator: "#282828",
      accent: "#FFC799",
      count: "#FFC799",
      link: "#99FFE4",
      inlineCode: "#99FFE4",
      error: "#FF8080",
      selectedBg: "#232323",
      selectedText: "#FFFFFF",
      green: "#99FFE4",
      yellow: "#FFC799",
      red: "#FF8080",
    },
  },
  vague: {
    name: "Vague",
    description: "Muted low-contrast charcoal with soft editor accents",
    tone: "dark",
    colors: {
      background: "#141415",
      modalBackground: "#1c1c24",
      text: "#cdcdcd",
      muted: "#606079",
      separator: "#252530",
      accent: "#6e94b2",
      count: "#e0a363",
      link: "#6e94b2",
      inlineCode: "#e8b589",
      error: "#d8647e",
      selectedBg: "#333738",
      selectedText: "#cdcdcd",
      green: "#7fa563",
      yellow: "#f3be7c",
      red: "#d8647e",
    },
  },
  ayu: {
    name: "Ayu",
    description: "Modern bright dark theme with blue and orange accents",
    tone: "dark",
    colors: {
      background: "#0f1419",
      modalBackground: "#131d27",
      text: "#bfbdb6",
      muted: "#565b66",
      separator: "#242936",
      accent: "#39bae6",
      count: "#f29718",
      link: "#73b8ff",
      inlineCode: "#73b8ff",
      error: "#f26d78",
      selectedBg: "#1c2c3b",
      selectedText: "#e6e1cf",
      green: "#7ee787",
      yellow: "#ffb454",
      red: "#f26d78",
    },
  },
  "ayu-mirage": {
    name: "Ayu Mirage",
    description: "Medium-contrast blue-gray with vibrant syntax colors",
    tone: "dark",
    colors: {
      background: "#1f2430",
      modalBackground: "#242936",
      text: "#cccac2",
      muted: "#8a9199",
      separator: "#33415e",
      accent: "#73b8ff",
      count: "#ffcc66",
      link: "#73b8ff",
      inlineCode: "#d2a6ff",
      error: "#f07178",
      selectedBg: "#2a3546",
      selectedText: "#ffffff",
      green: "#87d96c",
      yellow: "#ffcc66",
      red: "#f07178",
    },
  },
  "ayu-light": {
    name: "Ayu Light",
    description: "Clean light theme with crisp blue and orange accents",
    tone: "light",
    colors: {
      background: "#fcfcfc",
      modalBackground: "#f3f4f5",
      text: "#5c6166",
      muted: "#8a9199",
      separator: "#d3d5d8",
      accent: "#0580f2",
      count: "#f29718",
      link: "#399ee6",
      inlineCode: "#a37acc",
      error: "#e65050",
      selectedBg: "#e7eaed",
      selectedText: "#24292f",
      green: "#4cbf99",
      yellow: "#f29718",
      red: "#e65050",
    },
  },
  "github-dark-dimmed": {
    name: "GitHub Dark Dimmed",
    description: "GitHub-inspired muted dark blue-gray with soft accents",
    tone: "dark",
    colors: {
      background: "#22272e",
      modalBackground: "#2d333b",
      text: "#adbac7",
      muted: "#768390",
      separator: "#444c56",
      accent: "#539bf5",
      count: "#da3633",
      link: "#539bf5",
      inlineCode: "#f47067",
      error: "#e5534b",
      selectedBg: "#373e47",
      selectedText: "#cdd9e5",
      green: "#57ab5a",
      yellow: "#c69026",
      red: "#e5534b",
    },
  },
  palenight: {
    name: "Palenight",
    description: "Material-inspired purple-blue with soft lavender tones",
    tone: "dark",
    colors: {
      background: "#292d3e",
      modalBackground: "#313442",
      text: "#a6accd",
      muted: "#676e95",
      separator: "#3e4451",
      accent: "#82aaff",
      count: "#ffcb6b",
      link: "#82aaff",
      inlineCode: "#c792ea",
      error: "#ff5370",
      selectedBg: "#3d445b",
      selectedText: "#ffffff",
      green: "#c3e88d",
      yellow: "#ffcb6b",
      red: "#ff5370",
    },
  },
  opencode: {
    name: "OpenCode",
    description: "Charcoal panels with peach, violet, and blue highlights",
    tone: "dark",
    colors: {
      background: "#0a0a0a",
      modalBackground: "#1e1e1e",
      text: "#eeeeee",
      muted: "#808080",
      separator: "#484848",
      accent: "#fab283",
      count: "#fab283",
      link: "#5c9cf5",
      inlineCode: "#7fd88f",
      error: "#e06c75",
      selectedBg: "#323232",
      selectedText: "#eeeeee",
      green: "#7fd88f",
      yellow: "#f5a742",
      red: "#e06c75",
    },
  },
  cursor: {
    name: "Cursor",
    description: "Deep charcoal base with Anysphere's signature bright blue accents",
    tone: "dark",
    colors: {
      background: "#181818",
      modalBackground: "#232323",
      text: "#cccccc",
      muted: "#858585",
      separator: "#3c3c3c",
      accent: "#228df2",
      count: "#4fc1ff",
      link: "#4fc1ff",
      inlineCode: "#4ec9b0",
      error: "#f14c4c",
      selectedBg: "#26354c",
      selectedText: "#e8e8e8",
      green: "#4ec9b0",
      yellow: "#cca700",
      red: "#f14c4c",
    },
  },
} satisfies Record<ThemeId, ThemeDefinition>;

export interface ThemeEntry extends ThemeDefinition {
  readonly id: ThemeId;
}

export const themeList: ReadonlyArray<ThemeEntry> = themeIds.map((id) => ({
  id,
  ...themes[id],
}));

/**
 * The live palette. Mutated in place by setActiveTheme so every module reads
 * the current theme through one stable import; callers that render must
 * re-render after switching (App keys its tree on the theme id).
 */
export const colors = { ...themes[defaultThemeId].colors };

let activeThemeId: ThemeId = defaultThemeId;

export function activeTheme(): ThemeId {
  return activeThemeId;
}

export function setActiveTheme(id: ThemeId): void {
  activeThemeId = id;
  Object.assign(colors, themes[id].colors);
}

function hexToRgb(hex: string) {
  const value = hex.replace(/^#/, "").slice(0, 6);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b]
    .map((component) =>
      Math.max(0, Math.min(255, Math.round(component)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Linear blend of two hex colours; amount 0 returns base, 1 returns overlay. */
export function mixHex(base: string, overlay: string, amount: number): string {
  const from = hexToRgb(base);
  const to = hexToRgb(overlay);
  return rgbToHex({
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  });
}

/** Syntax colours for the document pane, baked from one palette; rebuild when the theme changes. */
export function createMarkdownSyntax(palette: ColorPalette = colors): SyntaxStyle {
  return SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: palette.text } },
    {
      scope: ["comment", "comment.documentation"],
      style: { foreground: palette.muted, italic: true },
    },
    {
      scope: ["string", "symbol", "character"],
      style: { foreground: palette.green },
    },
    {
      scope: ["number", "boolean", "constant"],
      style: { foreground: palette.count },
    },
    {
      scope: ["keyword", "keyword.return", "keyword.conditional", "keyword.repeat"],
      style: { foreground: palette.accent, bold: true },
    },
    {
      scope: ["function", "function.call", "function.method", "constructor"],
      style: { foreground: palette.link },
    },
    {
      scope: ["type", "class", "module", "type.builtin"],
      style: { foreground: palette.inlineCode },
    },
    {
      scope: ["variable", "variable.parameter", "property", "field"],
      style: { foreground: palette.text },
    },
    {
      scope: ["operator", "keyword.operator", "punctuation", "punctuation.bracket", "punctuation.delimiter"],
      style: { foreground: palette.muted },
    },
    {
      scope: ["markup.heading", "markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"],
      style: { foreground: palette.count, bold: true },
    },
    {
      scope: ["markup.heading.1"],
      style: { foreground: palette.accent, bold: true },
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: { foreground: palette.text, bold: true },
    },
    {
      scope: ["markup.italic", "markup.quote"],
      style: { foreground: palette.muted, italic: true },
    },
    { scope: ["markup.list"], style: { foreground: palette.count } },
    { scope: ["markup.list.checked"], style: { foreground: palette.green } },
    { scope: ["markup.list.unchecked"], style: { foreground: palette.muted } },
    {
      scope: ["markup.raw", "markup.raw.block", "markup.raw.inline"],
      style: { foreground: palette.inlineCode },
    },
    {
      scope: ["markup.link", "markup.link.label", "markup.link.url", "string.special.url"],
      style: { foreground: palette.link, underline: true },
    },
    { scope: ["conceal"], style: { foreground: palette.muted } },
    { scope: ["diff.plus"], style: { foreground: palette.green } },
    { scope: ["diff.minus"], style: { foreground: palette.red } },
    { scope: ["diff.delta"], style: { foreground: palette.yellow } },
  ]);
}
