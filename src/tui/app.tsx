/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Match } from "effect";
import { useKeyboard, usePaste, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { acceptVendorDrift, applyProfile, linkProjectSkill, restoreVendorDrift, setSkillsEnabled } from "../lib/catalog-actions.ts";
import type { ActionResult } from "../lib/catalog-actions.ts";
import { isClean, pagePatch, unifiedDiff } from "../lib/diff.ts";
import type { DiffPager } from "../lib/diff.ts";
import { defaultThemeId, getActiveProfile, themeIds } from "../domain/model.ts";
import type { ThemeId } from "../domain/model.ts";
import { addSkillFromSource, parseSkillsAddSource } from "../lib/skills-add.ts";
import { checkUpstream } from "../lib/update.ts";
import type { UpstreamStatus } from "../lib/update.ts";
import type { UnindexedSkill } from "../lib/adopt.ts";
import { runPromiseResult, runSync, runSyncResult } from "./runtime.ts";
import type { RunResult } from "./runtime.ts";
import { Divider, Filler, HintRow, PaneTitle, PlainLine, SeparatorColumn, TextLine } from "./components.tsx";
import type { Junction } from "./components.tsx";
import { activeTheme, colors, createMarkdownSyntax, mixHex, setActiveTheme, themes } from "./theme.ts";
import { centerCell, clamp, fileTreeRows, fitCell, markdownBody, markdownHeadingLines, printable, searchMatchLines, singleLinePaste, windowOf } from "./util.ts";
import { scrollRowForLine } from "./doc-nav.ts";
import type { DocRenderable } from "./doc-nav.ts";
import { copySelection, handleSelectionKey } from "./clipboard.ts";
import type { SelectionClipboard } from "./clipboard.ts";
import { editableHostSkillPath, editSkillInEditor, withSuspendedRenderer } from "./external.ts";
import { cycleLayout, primaryPanel, resizeFocusedSplit } from "./layout.ts";
import type { Panel, PrimaryPanel, TwoPanePair } from "./layout.ts";
import { useAppKeybindings } from "./use-app-keybindings.ts";
import type { AppCommand, AppKeymapState } from "./use-app-keybindings.ts";
import { DetailModal } from "./modals/detail-modal.tsx";
import { DiffModal } from "./modals/diff-modal.tsx";
import { HelpModal } from "./modals/help-modal.tsx";
import { IndexSkillModal } from "./modals/index-skill-modal.tsx";
import { LinkModal } from "./modals/link-modal.tsx";
import { ProfilesModal } from "./modals/profiles-modal.tsx";
import { ProjectSkillModal } from "./modals/project-skill-modal.tsx";
import { ThemeModal } from "./modals/theme-modal.tsx";
import { UnindexedSkillModal } from "./modals/unindexed-skill-modal.tsx";
import {
  diffSkill,
  expandHome,
  isSkillAvailableHere,
  loadCatalog,
  projectSkillFiles,
  projectPlacement,
  readProjectSkillFile,
  readSkillFile,
  readUnindexedSkillFile,
  saveTheme,
  skillFiles,
  unindexedSkillFiles,
  verifyRow,
} from "./data.ts";
import type { Catalog, CatalogRow, DiffResult, LiveStatus, ProjectPlacement, ProjectSkill } from "./data.ts";

type CatalogView = "available" | "all";
type SkillItem = { kind: "skill"; row: CatalogRow } | { kind: "project-skill"; skill: ProjectSkill } | { kind: "unindexed-skill"; skill: UnindexedSkill };

function skillItemName(item: SkillItem): string {
  return item.kind === "skill" ? item.row.name : item.skill.name;
}

interface AuthorGroup {
  label: string;
  enabledCount: number | null;
  hasDrift: boolean;
  rows: ReadonlyArray<CatalogRow> | null;
  skills: SkillItem[];
}

/** Tree group for a row: "local" or the vendor owner (vendor/<owner>/<skill>). */
function ownerOf(row: CatalogRow): string {
  if (row.origin === "local") return "local";
  return row.meta.path.split("/")[1] ?? "vendor";
}

export interface LinkFlow {
  step: "project" | "mode" | "options";
  input: string;
  recentIndex: number; // -1 = free text
  mode: "copy" | "symlink";
  exclude: boolean;
  claude: boolean;
  error?: string;
}

export interface IndexFlow {
  input: string;
  running: boolean;
  error?: string;
}

type Interaction =
  | { kind: "browse" }
  | { kind: "help" }
  | { kind: "detail"; item: SkillItem }
  | { kind: "profiles"; index: number }
  | { kind: "theme"; index: number; saved: ThemeId }
  | { kind: "diff"; row: CatalogRow; result: DiffResult }
  | { kind: "link"; row: CatalogRow; flow: LinkFlow }
  | { kind: "index"; skill: UnindexedSkill; flow: IndexFlow };

type CheckForUpstream = (manifest: Catalog["manifest"], signal: AbortSignal) => Promise<RunResult<ReadonlyArray<UpstreamStatus>>>;

export interface AppProps {
  clipboard: SelectionClipboard;
  checkForUpstream?: CheckForUpstream;
}

const defaultCheckForUpstream: CheckForUpstream = (manifest, signal) => runPromiseResult(checkUpstream(manifest), { signal });

function assertNever(value: never): never {
  throw new Error(`unhandled interaction: ${JSON.stringify(value)}`);
}

function keymapStateFor(interaction: Interaction, textInputActive: boolean): AppKeymapState {
  const inactive = { listActive: false, overlayActive: false, diffActive: false, profilesActive: false, helpActive: false, textInputActive };
  switch (interaction.kind) {
    case "browse":
      return { ...inactive, listActive: !textInputActive };
    case "help":
      return { ...inactive, overlayActive: true, helpActive: true };
    case "detail":
      return { ...inactive, overlayActive: true };
    case "profiles":
    case "theme":
      return { ...inactive, overlayActive: true, profilesActive: true };
    case "diff":
      return { ...inactive, overlayActive: true, diffActive: true };
    case "link":
    case "index":
      return inactive;
    default:
      return assertNever(interaction);
  }
}

const liveColorKey = {
  ok: "green",
  drift: "yellow",
  missing: "red",
  off: "muted",
  stale: "yellow",
  checking: "muted",
  unowned: "yellow",
} satisfies Record<LiveStatus, keyof typeof colors>;

/** Resolved against the active theme at call time. */
export function liveColor(status: LiveStatus): string {
  return colors[liveColorKey[status]];
}

export const liveLabel = {
  ok: "ok",
  drift: "drift",
  missing: "missing",
  off: "-",
  stale: "stale",
  checking: "\u2026",
  unowned: "unowned",
} satisfies Record<LiveStatus, string>;

const placementCells = {
  none: { label: "-", fg: "muted" },
  "link-hidden": { label: "link·hid", fg: "link" },
  "link-tracked": { label: "link·git", fg: "link" },
  "copy-hidden": { label: "copy·hid", fg: "link" },
  "copy-tracked": { label: "copy·git", fg: "link" },
  missing: { label: "missing", fg: "red" },
  unmanaged: { label: "unmanaged", fg: "yellow" },
} satisfies Record<ProjectPlacement, { label: string; fg: keyof typeof colors }>;

function placementCell(placement: ProjectPlacement) {
  const cell = placementCells[placement];
  return { label: cell.label, fg: colors[cell.fg] };
}

export function App({ clipboard, checkForUpstream = defaultCheckForUpstream }: AppProps) {
  const renderer = useRenderer();
  const { width: cols, height: rowsAvail } = useTerminalDimensions();

  const [catalog, setCatalog] = useState<Catalog>(() => runSync(loadCatalog()));
  const [selectedAuthor, setSelectedAuthor] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState(0);
  const [catalogView, setCatalogView] = useState<CatalogView>("available");
  const [panel, setPanel] = useState<Panel>("skills");
  const [expanded, setExpanded] = useState<PrimaryPanel | null>(null);
  const [twoPane, setTwoPane] = useState<TwoPanePair | null>(null);
  const [catalogSplit, setCatalogSplit] = useState(1 / 3);
  const [documentSplit, setDocumentSplit] = useState(0.4);
  const [interaction, setInteraction] = useState<Interaction>({ kind: "browse" });
  const [filterMode, setFilterMode] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [docFind, setDocFind] = useState<{ typing: boolean; query: string }>({ typing: false, query: "" });
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null);
  const [previewState, setPreviewState] = useState<{ skill: string | null; file: number; restore: number }>({ skill: null, file: 0, restore: 0 });
  const [themeId, setThemeId] = useState<ThemeId>(() => {
    const id = catalog.theme ?? defaultThemeId;
    setActiveTheme(id);
    return id;
  });

  const quitting = useRef(false);
  const mounted = useRef(true);
  const notificationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const indexTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upstreamGeneration = useRef(0);
  const upstreamAbort = useRef<AbortController | null>(null);
  const previewScroll = useRef<ScrollBoxRenderable | null>(null);
  const previewDoc = useRef<DocRenderable | null>(null);
  const findPos = useRef(-1);
  // Rebuilt per theme: the style bakes in palette colours at creation.
  const syntaxStyle = useMemo(() => createMarkdownSyntax(themes[themeId].colors), [themeId]);

  useEffect(() => () => syntaxStyle.destroy(), [syntaxStyle]);

  useEffect(() => {
    renderer.setBackgroundColor(colors.background);
  }, [renderer, themeId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      upstreamGeneration.current += 1;
      upstreamAbort.current?.abort();
      if (notificationTimer.current) clearTimeout(notificationTimer.current);
      if (indexTimer.current) clearTimeout(indexTimer.current);
    };
  }, []);

  /** Switch the live palette; the state change re-renders every consumer of `colors`. */
  const previewTheme = (id: ThemeId) => {
    if (activeTheme() !== id) setActiveTheme(id);
    setThemeId(id);
  };

  const filtered = useMemo(() => (filterText ? catalog.rows.filter((r) => r.name.includes(filterText.toLowerCase())) : catalog.rows), [catalog.rows, filterText]);

  const groups = useMemo<AuthorGroup[]>(() => {
    const out: AuthorGroup[] = [];
    const unindexed = catalog.unindexedSkills.filter((skill) => !filterText || skill.name.includes(filterText.toLowerCase()));
    const unindexedNames = new Set(catalog.unindexedSkills.map((skill) => skill.name));
    const projectOnly = catalog.projectSkills
      .filter((skill) => !Object.hasOwn(catalog.manifest.skills, skill.name) && !unindexedNames.has(skill.name) && (!filterText || skill.name.includes(filterText.toLowerCase())))
      .sort((a, b) => Number(b.agents) - Number(a.agents) || a.name.localeCompare(b.name));
    const projectNames = new Set(catalog.projectSkills.map((skill) => skill.name));
    const availableRows = filtered.filter(isSkillAvailableHere);
    const availableUnindexed = unindexed.filter((skill) => projectNames.has(skill.name));
    const available: SkillItem[] = [
      ...availableRows.map((row) => ({ kind: "skill" as const, row })),
      ...availableUnindexed.map((skill) => ({ kind: "unindexed-skill" as const, skill })),
      ...projectOnly.map((skill) => ({ kind: "project-skill" as const, skill })),
    ].sort((a, b) => skillItemName(a).localeCompare(skillItemName(b)));
    if (catalogView === "available") {
      out.push({
        label: "all available",
        enabledCount: null,
        hasDrift: availableRows.some((row) => row.live === "drift"),
        rows: null,
        skills: available,
      });
    }
    const scopedUnindexed = catalogView === "available" ? availableUnindexed : unindexed;
    if (scopedUnindexed.length > 0) {
      out.push({
        label: "unindexed",
        enabledCount: null,
        hasDrift: false,
        rows: null,
        skills: scopedUnindexed.map((skill) => ({ kind: "unindexed-skill", skill })),
      });
    }
    if (projectOnly.length > 0) {
      out.push({
        label: "project only",
        enabledCount: null,
        hasDrift: false,
        rows: null,
        skills: projectOnly.map((skill) => ({ kind: "project-skill", skill })),
      });
    }

    const byOwner = new Map<string, CatalogRow[]>();
    for (const row of catalogView === "available" ? availableRows : filtered) {
      const key = ownerOf(row);
      const bucket = byOwner.get(key);
      if (bucket) bucket.push(row);
      else byOwner.set(key, [row]);
    }
    const keys = [...byOwner.keys()].sort((a, b) => {
      if (a === "local") return -1;
      if (b === "local") return 1;
      return a < b ? -1 : 1;
    });
    for (const key of keys) {
      const rows = byOwner.get(key) ?? [];
      out.push({
        label: key,
        enabledCount: rows.filter((r) => r.enabled).length,
        hasDrift: rows.some((row) => row.live === "drift"),
        rows,
        skills: rows.map((row) => ({ kind: "skill", row })),
      });
    }
    return out;
  }, [catalog.manifest.skills, catalog.projectSkills, catalog.unindexedSkills, catalogView, filtered, filterText]);

  // Chrome: header, rail, tabs, rail, [body], rail, footer.
  const viewport = Math.max(3, rowsAvail - 6);
  const authorIndex = clamp(selectedAuthor, 0, Math.max(0, groups.length - 1));
  const currentGroup = groups[authorIndex];
  const skillIndex = clamp(selectedSkill, 0, Math.max(0, (currentGroup?.skills.length ?? 1) - 1));
  const currentItem = currentGroup?.skills[skillIndex];
  const current: CatalogRow | undefined = currentItem?.kind === "skill" ? currentItem.row : undefined;
  const currentProjectSkill: ProjectSkill | undefined = currentItem?.kind === "project-skill" ? currentItem.skill : undefined;
  const currentUnindexedSkill: UnindexedSkill | undefined = currentItem?.kind === "unindexed-skill" ? currentItem.skill : undefined;
  const profileNames = Object.keys(catalog.manifest.profiles);

  const currentName = current?.name ?? currentProjectSkill?.name ?? currentUnindexedSkill?.name;
  const editableSkillPath = editableHostSkillPath(panel !== "authors", current ? { origin: current.origin, path: current.meta.path } : undefined, currentUnindexedSkill);
  const previewFile = previewState.skill === currentName ? previewState.file : 0;
  const previewRestore = previewState.skill === currentName ? previewState.restore : 0;

  const previewData = useMemo(() => {
    const files = Match.value(currentItem).pipe(
      Match.when({ kind: "skill" }, ({ row }) => skillFiles(catalog.repo, row.meta)),
      Match.when({ kind: "project-skill" }, ({ skill }) => projectSkillFiles(catalog.project, skill)),
      Match.when({ kind: "unindexed-skill" }, ({ skill }) => unindexedSkillFiles(skill)),
      Match.orElse(() => []),
    );
    if (files.length === 0) return null;
    const idx = clamp(previewFile, 0, files.length - 1);
    const file = files[idx] ?? "SKILL.md";
    const content = Match.value(currentItem).pipe(
      Match.when({ kind: "skill" }, ({ row }) => readSkillFile(catalog.repo, row.meta, file)),
      Match.when({ kind: "project-skill" }, ({ skill }) => readProjectSkillFile(catalog.project, skill, file)),
      Match.when({ kind: "unindexed-skill" }, ({ skill }) => readUnindexedSkillFile(skill, file)),
      Match.orElse(() => ""),
    );
    return { files, idx, file, content };
  }, [currentItem, catalog.project, catalog.repo, previewFile]);

  const docLines = useMemo(() => {
    if (!previewData) return null;
    const extension = extname(previewData.file).slice(1).toLowerCase();
    const markdown = extension === "md" || extension === "mdx";
    const content = markdown ? markdownBody(previewData.file, previewData.content) : previewData.content;
    return { markdown, lines: content.split("\n") };
  }, [previewData]);
  const docMatches = useMemo(() => (docLines && docFind.query ? searchMatchLines(docLines.lines, docFind.query) : []), [docLines, docFind.query]);
  const docHeadings = useMemo(() => (docLines?.markdown ? markdownHeadingLines(docLines.lines) : []), [docLines]);

  useEffect(() => {
    previewScroll.current?.scrollTo(0);
  }, [currentName, previewData?.file]);

  useEffect(() => {
    findPos.current = -1;
  }, [currentName, previewData?.file, docFind.query]);

  // Incrementally hash-verify vendor rows after (re)load.
  useEffect(() => {
    const row = catalog.rows.find((candidate) => candidate.live === "checking");
    if (!row) return;
    const timer = setTimeout(() => {
      const verified = verifyRow({ agentsSkills: catalog.agentsSkills, repo: catalog.repo }, row);
      setCatalog((previous) => ({
        ...previous,
        rows: previous.rows.map((candidate) => (candidate.name === verified.name && candidate.live === "checking" ? verified : candidate)),
      }));
    }, 0);
    return () => clearTimeout(timer);
  }, [catalog.rows, catalog.agentsSkills, catalog.repo]);

  const refresh = () => {
    upstreamGeneration.current += 1;
    upstreamAbort.current?.abort();
    upstreamAbort.current = null;
    setCatalog(runSync(loadCatalog()));
  };

  const notify = (text: string, error = false) => {
    if (!mounted.current) return;
    setFlash({ text, error });
    if (notificationTimer.current) clearTimeout(notificationTimer.current);
    notificationTimer.current = setTimeout(() => {
      notificationTimer.current = null;
      if (mounted.current) setFlash(null);
    }, 3000);
  };
  // The renderer emits `selection` exactly when a drag finishes, so this fires
  // per completed selection rather than on every mouse release.
  useSelectionHandler(() => {
    copySelection(renderer, clipboard, { notify });
  });

  const reportAction = (label: string, res: ActionResult) => {
    if (res.warnings.length > 0) notify(`${label}: ${res.warnings[0]}`, true);
    else notify(`${label} (${res.messages.length} change${res.messages.length === 1 ? "" : "s"})`);
  };

  const quit = () => {
    if (quitting.current) return;
    quitting.current = true;
    renderer.destroy();
  };

  // ---- document navigation ----------------------------------------------

  const docRowFor = (line: number): number | null => {
    const scroll = previewScroll.current;
    if (!scroll || !docLines) return null;
    const doc = previewDoc.current;
    const row = doc ? scrollRowForLine(doc, scroll, line, docLines.lines.length) : 0;
    return clamp(row, 0, Math.max(0, scroll.scrollHeight - scroll.viewport.height));
  };

  const jumpMatch = (delta: 1 | -1) => {
    if (!docFind.query) return notify("no document search yet \u2014 press / in the document pane", true);
    if (docMatches.length === 0) return notify(`no matches for "${docFind.query}"`, true);
    const len = docMatches.length;
    const next = findPos.current === -1 ? (delta === 1 ? 0 : len - 1) : (findPos.current + delta + len) % len;
    findPos.current = next;
    const line = docMatches[next] ?? 0;
    const row = docRowFor(line);
    if (row !== null) previewScroll.current?.scrollTo(row);
    notify(`match ${next + 1}/${len} \u00b7 line ${line + 1}`);
  };

  const jumpHeading = (delta: 1 | -1) => {
    const scroll = previewScroll.current;
    if (!scroll || !docLines) return;
    if (docHeadings.length === 0) return notify(docLines.markdown ? "no headings in this document" : "headings only apply to markdown", true);
    const rows = docHeadings.map((line) => docRowFor(line) ?? 0);
    const top = scroll.scrollTop;
    const target = delta === 1 ? rows.find((row) => row > top) : [...rows].reverse().find((row) => row < top);
    if (target !== undefined) scroll.scrollTo(target);
  };

  // ---- keyboard ----------------------------------------------------------

  const handleFilter = (key: KeyEvent): boolean => {
    if (!filterMode) return false;
    if (key.name === "escape") {
      setFilterMode(false);
      setFilterText("");
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      setFilterMode(false);
      return true;
    }
    if (key.name === "backspace") {
      setFilterText((t) => t.slice(0, -1));
      return true;
    }
    const p = printable(key);
    if (p) {
      setFilterText((t) => t + p);
      setSelectedAuthor(0);
      setSelectedSkill(0);
    }
    return true;
  };

  const handleFind = (key: KeyEvent): boolean => {
    if (!docFind.typing) return false;
    if (key.name === "escape") {
      setDocFind({ typing: false, query: "" });
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      setDocFind((f) => ({ ...f, typing: false }));
      if (!docFind.query) return true;
      if (docMatches.length === 0) {
        notify(`no matches for "${docFind.query}"`, true);
        return true;
      }
      findPos.current = 0;
      const line = docMatches[0] ?? 0;
      const row = docRowFor(line);
      if (row !== null) previewScroll.current?.scrollTo(row);
      notify(`match 1/${docMatches.length} \u00b7 line ${line + 1}`);
      return true;
    }
    if (key.name === "backspace") {
      setDocFind((f) => ({ ...f, query: f.query.slice(0, -1) }));
      return true;
    }
    const p = printable(key);
    if (p) setDocFind((f) => ({ ...f, query: f.query + p }));
    return true;
  };

  const patchLinkFlow = (fn: (prev: LinkFlow) => LinkFlow) => setInteraction((previous) => (previous.kind === "link" ? { ...previous, flow: fn(previous.flow) } : previous));

  const patchIndexFlow = (fn: (prev: IndexFlow) => IndexFlow) => setInteraction((previous) => (previous.kind === "index" ? { ...previous, flow: fn(previous.flow) } : previous));

  const handleIndex = (key: KeyEvent): boolean => {
    if (interaction.kind !== "index") return true;
    const { flow, skill } = interaction;
    if (flow.running) return true;
    if (key.name === "escape") {
      setInteraction({ kind: "browse" });
      return true;
    }
    if (key.name === "backspace") {
      patchIndexFlow((flow) => ({ ...flow, input: flow.input.slice(0, -1), error: undefined }));
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      let source: string;
      try {
        source = parseSkillsAddSource(flow.input, skill.name);
      } catch (error) {
        patchIndexFlow((flow) => ({ ...flow, error: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      patchIndexFlow((flow) => ({ ...flow, running: true, error: undefined }));
      indexTimer.current = setTimeout(() => {
        indexTimer.current = null;
        if (!mounted.current) return;
        const outcome = runSyncResult(addSkillFromSource(source, skill.name, { unindexedSkill: skill }));
        if (outcome.ok) {
          const result = outcome.value;
          setInteraction({ kind: "browse" });
          refresh();
          if (result.warnings.length > 0) notify(`indexed ${skill.name}: ${result.warnings[0]}`, true);
          else notify(`indexed ${skill.name} -> ${result.path}`);
        } else {
          patchIndexFlow((flow) => ({ ...flow, running: false, error: outcome.message }));
        }
      }, 0);
      return true;
    }
    const value = printable(key);
    if (value) patchIndexFlow((flow) => ({ ...flow, input: flow.input + value, error: undefined }));
    return true;
  };

  const handleLink = (key: KeyEvent): boolean => {
    if (interaction.kind !== "link") return true;
    const { flow, row } = interaction;
    if (key.name === "escape") {
      setInteraction({ kind: "browse" });
      return true;
    }
    if (flow.step === "project") {
      const recents = catalog.state.recentProjects;
      if (key.name === "up" || key.name === "down") {
        if (recents.length === 0) return true;
        const dir = key.name === "down" ? 1 : -1;
        patchLinkFlow((f) => {
          const next = clamp(f.recentIndex + dir, 0, recents.length - 1);
          return { ...f, recentIndex: next, input: recents[next] ?? f.input };
        });
        return true;
      }
      if (key.name === "return" || key.name === "enter") {
        patchLinkFlow((f) => {
          const path = expandHome(f.input.trim());
          if (!path || !existsSync(path)) {
            return { ...f, error: `not a directory: ${path || "(empty)"}` };
          }
          return { ...f, input: path, step: "mode", error: undefined };
        });
        return true;
      }
      if (key.name === "backspace") {
        patchLinkFlow((f) => ({ ...f, input: f.input.slice(0, -1), recentIndex: -1 }));
        return true;
      }
      const p = printable(key);
      if (p) patchLinkFlow((f) => ({ ...f, input: f.input + p, recentIndex: -1 }));
      return true;
    }
    if (flow.step === "mode") {
      if (key.name === "j" || key.name === "k" || key.name === "up" || key.name === "down") {
        patchLinkFlow((f) => ({ ...f, mode: f.mode === "copy" ? "symlink" : "copy" }));
        return true;
      }
      if (key.name === "c") {
        patchLinkFlow((f) => ({ ...f, mode: "copy" }));
        return true;
      }
      if (key.name === "s") {
        patchLinkFlow((f) => ({ ...f, mode: "symlink" }));
        return true;
      }
      if (key.name === "return" || key.name === "enter") {
        patchLinkFlow((f) => ({ ...f, step: "options" }));
        return true;
      }
      return true;
    }
    // options
    if (key.name === "e") {
      patchLinkFlow((f) => ({ ...f, exclude: !f.exclude }));
      return true;
    }
    if (key.name === "c") {
      patchLinkFlow((f) => ({ ...f, claude: !f.claude }));
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      const outcome = runSyncResult(
        linkProjectSkill({
          skill: row.name,
          project: flow.input,
          mode: flow.mode,
          gitExclude: flow.exclude,
          claude: flow.claude,
        }),
      );
      if (outcome.ok) notify(`linked ${row.name} (${flow.mode}) into ${flow.input}`);
      else notify(outcome.message, true);
      setInteraction({ kind: "browse" });
      refresh();
      return true;
    }
    return true;
  };

  // ---- panel + selection navigation (shared by keyboard and mouse) -------

  const focusPanel = (next: Panel) => {
    if ((panel === "content" || panel === "files") && next !== "content" && next !== "files") {
      setPreviewState({ skill: currentName ?? null, file: previewFile, restore: previewScroll.current?.scrollTop ?? 0 });
    }
    setPanel(next);
    setExpanded(null);
  };
  const moveAuthor = (delta: number) => {
    setSelectedAuthor(clamp(authorIndex + delta, 0, Math.max(0, groups.length - 1)));
    setSelectedSkill(0);
  };
  const moveSkill = (delta: number) => setSelectedSkill(clamp(skillIndex + delta, 0, Math.max(0, (currentGroup?.skills.length ?? 1) - 1)));
  const moveFile = (delta: number) => {
    if (!previewData) return;
    setPreviewState({ skill: currentName ?? null, file: clamp(previewFile + delta, 0, previewData.files.length - 1), restore: 0 });
  };
  const selectFile = (index: number) => {
    if (!previewData) return;
    setPreviewState({ skill: currentName ?? null, file: clamp(index, 0, previewData.files.length - 1), restore: 0 });
  };
  const switchCatalogView = (view: CatalogView) => {
    setCatalogView(view);
    setSelectedAuthor(0);
    setSelectedSkill(0);
  };
  const cyclePaneLayout = (direction: 1 | -1) => {
    const next = cycleLayout({ twoPane, expanded }, panel, direction);
    if (next.twoPane === "catalog" && twoPane !== "catalog") {
      setDocFind({ typing: false, query: "" });
    }
    setTwoPane(next.twoPane);
    setExpanded(next.expanded);
  };
  const editCurrentSkill = () => {
    if (!editableSkillPath) {
      let reason: string;
      if (panel === "authors") reason = "focus the skill or document pane first";
      else if (current?.origin === "vendor" || currentUnindexedSkill?.origin === "vendor") reason = "vendor baselines must be changed through update and vendor";
      else if (currentUnindexedSkill?.origin === "agent") reason = "the staging inbox can be overwritten; index the skill before editing";
      else reason = "project-only skills are outside the skills host";
      notify(`cannot edit here: ${reason}`, true);
      return;
    }
    try {
      withSuspendedRenderer(renderer, () => editSkillInEditor(catalog.editorCommand, catalog.repo, editableSkillPath));
      refresh();
      notify(
        current ? `edited ${current.name} · run slinky rehash ${current.name} before saving` : `edited ${currentUnindexedSkill?.name ?? "skill"} · press a to index it when ready`,
      );
    } catch (error) {
      notify(`${catalog.editorCommand[0]} failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };

  const panelOrder = Match.value({ twoPane, hasPreview: previewData !== null }).pipe(
    Match.when({ twoPane: "catalog" }, (): Panel[] => ["authors", "skills"]),
    Match.when({ twoPane: "document", hasPreview: true }, (): Panel[] => ["skills", "content", "files"]),
    Match.when({ twoPane: "document" }, (): Panel[] => ["skills", "content"]),
    Match.when({ hasPreview: true }, (): Panel[] => ["authors", "skills", "content", "files"]),
    Match.orElse((): Panel[] => ["authors", "skills", "content"]),
  );

  const movePanel = (delta: number) => {
    const index = Math.max(0, panelOrder.indexOf(panel));
    focusPanel(panelOrder[clamp(index + delta, 0, panelOrder.length - 1)] ?? panel);
  };

  const moveFocused = (delta: number) => {
    if (panel === "authors") moveAuthor(delta);
    else if (panel === "skills") moveSkill(delta);
    else if (panel === "files") moveFile(delta);
    else previewScroll.current?.scrollBy(delta);
  };

  const moveToBoundary = (last: boolean) => {
    if (panel === "authors") setSelectedAuthor(last ? Math.max(0, groups.length - 1) : 0);
    else if (panel === "skills") setSelectedSkill(last ? Math.max(0, (currentGroup?.skills.length ?? 1) - 1) : 0);
    else if (panel === "files") {
      setPreviewState({ skill: currentName ?? null, file: last ? Math.max(0, (previewData?.files.length ?? 1) - 1) : 0, restore: 0 });
    } else previewScroll.current?.scrollTo(last ? previewScroll.current.scrollHeight : 0);
  };

  const runAppCommand = (command: AppCommand, key: KeyEvent): void => {
    switch (command) {
      case "app.copy-or-quit":
        if (!handleSelectionKey(renderer, clipboard, key, { notify }) && interaction.kind === "browse") quit();
        return;
      case "app.quit":
        quit();
        return;
      case "overlay.close":
      case "help.close":
        if (interaction.kind === "theme") previewTheme(interaction.saved);
        setInteraction({ kind: "browse" });
        return;
      case "diff.accept": {
        if (interaction.kind !== "diff" || interaction.result.kind !== "diff" || isClean(interaction.result.diff)) return;
        const outcome = runSyncResult(acceptVendorDrift(interaction.row.name));
        if (outcome.ok) {
          const warning = outcome.value.warning;
          notify(warning ? `accepted ${interaction.row.name}: ${warning.message}` : `accepted global ${interaction.row.name} as the repo baseline`, warning !== undefined);
          refresh();
          setInteraction({ kind: "browse" });
        } else notify(outcome.message, true);
        return;
      }
      case "diff.restore": {
        if (interaction.kind !== "diff" || interaction.result.kind !== "diff" || isClean(interaction.result.diff)) return;
        const outcome = runSyncResult(restoreVendorDrift(interaction.row.name));
        if (outcome.ok) {
          notify(`restored global ${interaction.row.name} from the repo baseline`);
          refresh();
          setInteraction({ kind: "browse" });
        } else notify(outcome.message, true);
        return;
      }
      case "diff.hunk":
      case "diff.delta": {
        if (interaction.kind !== "diff" || interaction.result.kind !== "diff" || isClean(interaction.result.diff)) return;
        const currentDiff = diffSkill(catalog, interaction.row);
        if (currentDiff.kind !== "diff") {
          setInteraction({ ...interaction, result: currentDiff });
          notify(currentDiff.kind === "unowned" ? "live path is not owned by this catalog" : "live copy is no longer available", true);
          return;
        }
        const pager: DiffPager = command === "diff.hunk" ? "hunk" : "delta";
        let suspended = false;
        try {
          const patch = unifiedDiff(join(catalog.repo, interaction.row.meta.path), join(catalog.agentsSkills, interaction.row.name));
          renderer.suspend();
          suspended = true;
          pagePatch(patch, pager);
        } catch (error) {
          notify(`${pager} failed: ${error instanceof Error ? error.message : String(error)}`, true);
        } finally {
          if (suspended) renderer.resume();
        }
        return;
      }
      case "profiles.next":
      case "profiles.previous": {
        const delta = command === "profiles.next" ? 1 : -1;
        if (interaction.kind === "theme") {
          const index = clamp(interaction.index + delta, 0, themeIds.length - 1);
          previewTheme(themeIds[index] ?? defaultThemeId);
          setInteraction({ ...interaction, index });
          return;
        }
        setInteraction((previous) => (previous.kind === "profiles" ? { ...previous, index: clamp(previous.index + delta, 0, profileNames.length - 1) } : previous));
        return;
      }
      case "profiles.apply": {
        if (interaction.kind === "theme") {
          const id = themeIds[interaction.index] ?? defaultThemeId;
          const outcome = runSyncResult(saveTheme(id));
          if (outcome.ok) notify(`theme set to ${id}`);
          else notify(outcome.message, true);
          setInteraction({ kind: "browse" });
          return;
        }
        if (interaction.kind !== "profiles") return;
        const name = profileNames[interaction.index];
        if (name) {
          reportAction(`profile ${name}`, runSync(applyProfile(name)));
          refresh();
        }
        setInteraction({ kind: "browse" });
        return;
      }
      case "view.available":
        switchCatalogView("available");
        return;
      case "view.all":
        switchCatalogView("all");
        return;
      case "panel.next-wrap": {
        const index = Math.max(0, panelOrder.indexOf(panel));
        focusPanel(panelOrder[(index + 1) % panelOrder.length] ?? "authors");
        return;
      }
      case "panel.next":
        movePanel(1);
        return;
      case "panel.previous":
        movePanel(-1);
        return;
      case "panel.first":
        focusPanel("authors");
        return;
      case "panel.last":
        focusPanel(panelOrder.at(-1) ?? "skills");
        return;
      case "layout.zoom": {
        const focusedPrimary = primaryPanel(panel);
        setExpanded((value) => (value === focusedPrimary ? null : focusedPrimary));
        return;
      }
      case "layout.next":
        cyclePaneLayout(1);
        return;
      case "layout.previous":
        cyclePaneLayout(-1);
        return;
      case "layout.shrink":
      case "layout.grow": {
        if (!twoPane || expanded) return;
        const grow = command === "layout.grow";
        if (twoPane === "catalog") setCatalogSplit((split) => resizeFocusedSplit(split, twoPane, panel, grow));
        else setDocumentSplit((split) => resizeFocusedSplit(split, twoPane, panel, grow));
        return;
      }
      case "app.escape":
        if (expanded) setExpanded(null);
        else if (twoPane) setTwoPane(null);
        else if (docFind.query) setDocFind({ typing: false, query: "" });
        else if (filterText) setFilterText("");
        return;
      case "document.next-heading":
        jumpHeading(1);
        return;
      case "document.previous-heading":
        jumpHeading(-1);
        return;
      case "document.next-file":
        if (previewData) moveFile(1);
        return;
      case "document.previous-file":
        if (previewData) moveFile(-1);
        return;
      case "document.scroll-three-down":
        previewScroll.current?.scrollBy(3);
        return;
      case "document.scroll-three-up":
        previewScroll.current?.scrollBy(-3);
        return;
      case "document.page-down":
        previewScroll.current?.scrollBy(viewport - 3);
        return;
      case "document.page-up":
        previewScroll.current?.scrollBy(-(viewport - 3));
        return;
      case "document.scroll-line-down":
        previewScroll.current?.scrollBy(1);
        return;
      case "document.scroll-line-up":
        previewScroll.current?.scrollBy(-1);
        return;
      case "selection.next":
        moveFocused(1);
        return;
      case "selection.previous":
        moveFocused(-1);
        return;
      case "selection.half-page-down":
        moveFocused(Math.floor(viewport / 2));
        return;
      case "selection.half-page-up":
        moveFocused(-Math.floor(viewport / 2));
        return;
      case "selection.page-down":
        moveFocused(Math.max(1, viewport - 2));
        return;
      case "selection.page-up":
        moveFocused(-Math.max(1, viewport - 2));
        return;
      case "selection.first":
        if (key.repeated !== true) moveToBoundary(false);
        return;
      case "selection.last":
        moveToBoundary(true);
        return;
      case "search.open":
        if (panel === "content" && previewData) setDocFind({ typing: true, query: "" });
        else {
          setFilterMode(true);
          setFilterText("");
        }
        return;
      case "search.next":
        jumpMatch(1);
        return;
      case "search.previous":
        jumpMatch(-1);
        return;
      case "catalog.refresh":
        refresh();
        notify("refreshed");
        return;
      case "skill.edit":
        editCurrentSkill();
        return;
      case "help.open":
        setInteraction({ kind: "help" });
        return;
      case "upstream.check": {
        notify("checking upstream\u2026");
        upstreamAbort.current?.abort();
        const controller = new AbortController();
        upstreamAbort.current = controller;
        const generation = ++upstreamGeneration.current;
        const manifest = catalog.manifest;
        void (async () => {
          let outcome: RunResult<ReadonlyArray<UpstreamStatus>>;
          try {
            outcome = await checkForUpstream(manifest, controller.signal);
          } catch (error) {
            outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
          }
          if (!mounted.current || generation !== upstreamGeneration.current) return;
          upstreamAbort.current = null;
          if (!outcome.ok) {
            notify(`upstream check failed: ${outcome.message}`, true);
            return;
          }
          const statuses = outcome.value;
          const byName = new Map(statuses.map((status) => [status.name, status.state]));
          setCatalog((previous) => ({
            ...previous,
            rows: previous.rows.map((row) => {
              const state = byName.get(row.name);
              return state ? { ...row, upstream: state } : row;
            }),
          }));
          const updates = statuses.filter((status) => status.state === "update").length;
          const gone = statuses.filter((status) => status.state === "gone").length;
          notify(updates + gone === 0 ? "upstream: everything current" : `upstream: ${updates} update(s), ${gone} gone \u2014 run slinky update`);
        })();
        return;
      }
      case "theme.open": {
        const saved = catalog.theme ?? themeId;
        setInteraction({ kind: "theme", index: Math.max(0, themeIds.indexOf(themeId)), saved });
        return;
      }
      case "profiles.open":
        if (profileNames.length === 0) {
          notify("no profiles defined in skills.manifest.json", true);
          return;
        }
        setInteraction({ kind: "profiles", index: Math.max(0, profileNames.indexOf(getActiveProfile(catalog.manifest, catalog.state) ?? "")) });
        return;
      case "selection.open":
        if (panel === "authors") setPanel("skills");
        else if (panel === "skills" && twoPane === "catalog" && currentItem) setInteraction({ kind: "detail", item: currentItem });
        else if (panel === "skills" || panel === "files") setPanel("content");
        else if (currentItem) setInteraction({ kind: "detail", item: currentItem });
        return;
      case "selection.toggle":
        if (panel === "authors" && currentGroup?.rows) {
          const enable = !currentGroup.rows.some((row) => row.enabled);
          const result = runSync(
            setSkillsEnabled(
              currentGroup.rows.map((row) => row.name),
              enable,
            ),
          );
          reportAction(`${enable ? "enabled" : "disabled"} ${currentGroup.label}`, result);
          refresh();
        } else if (panel === "skills" && current) {
          const result = runSync(setSkillsEnabled([current.name], !current.enabled));
          reportAction(`${current.enabled ? "disabled" : "enabled"} ${current.name}`, result);
          refresh();
        }
        return;
      case "skill.details":
        if (currentItem) setInteraction({ kind: "detail", item: currentItem });
        return;
      case "skill.index":
        if (currentUnindexedSkill) {
          setInteraction({ kind: "index", skill: currentUnindexedSkill, flow: { input: "", running: false } });
        }
        return;
      case "skill.diff":
        if (current) {
          setInteraction({ kind: "diff", row: current, result: diffSkill(catalog, current) });
        }
        return;
      case "skill.link":
        if (!current) return;
        setInteraction({
          kind: "link",
          row: current,
          flow: {
            step: "project",
            input: process.cwd() !== catalog.repo ? process.cwd() : (catalog.state.recentProjects[0] ?? ""),
            recentIndex: -1,
            mode: "copy",
            exclude: true,
            claude: true,
          },
        });
        return;
    }
  };

  const textInputActive = filterMode || docFind.typing || interaction.kind === "link" || interaction.kind === "index";
  useAppKeybindings(keymapStateFor(interaction, textInputActive), runAppCommand);

  useKeyboard((key) => {
    if (handleFilter(key)) return;
    if (handleFind(key)) return;
    if (interaction.kind === "link") handleLink(key);
    else if (interaction.kind === "index") handleIndex(key);
  });

  usePaste((event) => {
    if (interaction.kind !== "index" || interaction.flow.running) return;
    event.preventDefault();
    event.stopPropagation();
    const value = singleLinePaste(event.bytes);
    if (value) patchIndexFlow((flow) => ({ ...flow, input: flow.input + value, error: undefined }));
  });

  // ---- render ------------------------------------------------------------

  const enabledCount = catalog.rows.filter((r) => r.enabled).length;
  const hereCount = catalog.projectSkills.length;
  const availableCount = new Set([...catalog.rows.filter(isSkillAvailableHere).map((row) => row.name), ...catalog.projectSkills.map((skill) => skill.name)]).size;
  const allCount = new Set([...catalog.rows.map((row) => row.name), ...catalog.unindexedSkills.map((skill) => skill.name), ...catalog.projectSkills.map((skill) => skill.name)])
    .size;
  const projectName = basename(catalog.project) || catalog.project;
  const matchCount = new Set(groups.flatMap((group) => group.skills.map(skillItemName))).size;
  const narrow = cols < (twoPane ? 64 : 96);
  const tiny = cols < 48;
  const compactHeader = cols < 72;
  const focusedPrimary = primaryPanel(panel);
  const showAuthors = expanded ? expanded === "authors" : narrow ? focusedPrimary === "authors" : twoPane !== "document";
  const showSkills = expanded ? expanded === "skills" : narrow ? focusedPrimary === "skills" : true;
  const showContent = expanded ? expanded === "content" : narrow ? focusedPrimary === "content" : twoPane !== "catalog";
  const visiblePanes = [showAuthors, showSkills, showContent].filter(Boolean).length;
  // Content widths; every rail between two panes costs one more column.
  const railCols = Math.max(0, visiblePanes - 1);
  const authorW = Math.max(18, Math.min(25, Math.floor(cols * 0.19)));
  const skillW = Math.max(33, Math.min(42, Math.floor(cols * 0.31)));
  const catalogAuthorW = Math.max(18, Math.min(cols - 34, Math.floor(cols * catalogSplit)));
  const documentSkillW = Math.max(33, Math.min(cols - 31, Math.floor(cols * documentSplit)));
  const fileTreeW = Math.max(18, Math.min(28, Math.floor(cols * 0.21)));
  const authorViewport = Math.max(1, viewport - 1);
  const authorWin = windowOf(0, authorIndex, groups.length, authorViewport);
  const skillViewport = Math.max(1, viewport - 1);
  const skillWin = windowOf(0, skillIndex, currentGroup?.skills.length ?? 0, skillViewport);
  const authorsWidth = !showAuthors ? 0 : visiblePanes === 1 ? cols : twoPane === "catalog" ? catalogAuthorW : authorW;
  let skillsWidth = 0;
  if (showSkills) {
    if (visiblePanes === 1) skillsWidth = cols;
    else if (twoPane === "catalog") skillsWidth = cols - catalogAuthorW - 1;
    else if (twoPane === "document") skillsWidth = documentSkillW;
    else skillsWidth = skillW;
  }
  const contentWidth = showContent ? Math.max(20, cols - authorsWidth - skillsWidth - railCols) : 0;
  const authorLabelW = Math.max(4, authorsWidth - 9);
  const skillLabelW = Math.max(4, skillsWidth - 26);
  const fileTreeMode: "split" | "hidden" | "only" = tiny ? (panel === "files" ? "only" : "hidden") : "split";

  const upstreamCell = (row: CatalogRow): { label: string; fg: string } =>
    Match.value(row.upstream).pipe(
      Match.when("update", () => ({ label: "^", fg: colors.yellow })),
      Match.when("gone", () => ({ label: "×", fg: colors.red })),
      Match.when("current", () => ({ label: "=", fg: colors.muted })),
      Match.orElse(() => ({ label: "", fg: colors.muted })),
    );

  const header = (
    <box height={1} width="100%" flexDirection="row" justifyContent="space-between">
      <text wrapMode="none" truncate>
        <span> </span>
        <span fg={colors.accent} attributes={TextAttributes.BOLD}>
          slinky
        </span>
        <span fg={colors.separator} attributes={TextAttributes.BOLD}>
          {" / "}
        </span>
        <span fg={colors.text} attributes={TextAttributes.BOLD}>
          {projectName}
        </span>
      </text>
      {!compactHeader ? (
        <text wrapMode="none" truncate>
          <span fg={colors.muted}>{`global ${enabledCount}/${catalog.rows.length} · local ${hereCount}`}</span>
          {catalog.unindexedSkills.length > 0 ? <span fg={colors.yellow}>{` · unindexed ${catalog.unindexedSkills.length}`}</span> : null}
          <span> </span>
        </text>
      ) : null}
    </box>
  );

  const tabDefs = [
    { view: "available" as const, label: compactHeader ? "AVAILABLE" : "AVAILABLE HERE", count: availableCount },
    { view: "all" as const, label: compactHeader ? "ALL" : "ALL SKILLS", count: allCount },
  ];
  // Column of each `│` between/after tabs, so the rails above and below can meet it.
  const tabRailColumns: number[] = [];
  {
    let column = 0;
    for (const tab of tabDefs) {
      column += ` ${tab.label} ${tab.count} `.length;
      tabRailColumns.push(column);
      column += 1;
    }
  }
  const activeProfile = getActiveProfile(catalog.manifest, catalog.state);
  const tabs = (
    <box height={1} width="100%" flexDirection="row" justifyContent="space-between">
      <box height={1} flexDirection="row">
        {tabDefs.map((tab, index) => {
          const active = catalogView === tab.view;
          return (
            <box key={tab.view} height={1} flexDirection="row">
              {index > 0 ? <PlainLine text="│" fg={colors.separator} /> : null}
              <text
                wrapMode="none"
                truncate
                onMouseDown={() => {
                  if (interaction.kind === "browse") switchCatalogView(tab.view);
                }}
              >
                <span> </span>
                <span fg={active ? colors.accent : colors.muted} attributes={active ? TextAttributes.BOLD : 0}>
                  {tab.label}
                </span>
                <span fg={active ? mixHex(colors.separator, colors.accent, 0.45) : colors.separator}>{` ${tab.count} `}</span>
              </text>
            </box>
          );
        })}
        <PlainLine text="│" fg={colors.separator} />
      </box>
      {activeProfile && !tiny ? (
        <text wrapMode="none" truncate>
          <span fg={colors.muted}>{"profile "}</span>
          <span fg={colors.count}>{activeProfile}</span>
          <span> </span>
        </text>
      ) : null}
    </box>
  );

  // Mouse: click selects a row (and focuses its panel); wheel moves the selection.
  const clickAuthorRow = (index: number) => (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    if (interaction.kind !== "browse") return;
    if (panel !== "authors") focusPanel("authors");
    setSelectedAuthor(index);
    setSelectedSkill(0);
  };
  const clickSkillRow = (index: number) => (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    if (interaction.kind !== "browse") return;
    if (panel !== "skills") focusPanel("skills");
    setSelectedSkill(index);
  };
  const clickPanel = (target: Panel) => () => {
    if (interaction.kind !== "browse") return;
    if (panel !== target) focusPanel(target);
  };
  const wheelList = (move: (delta: number) => void) => (event: { stopPropagation: () => void; scroll?: { direction: string } }) => {
    event.stopPropagation();
    if (interaction.kind !== "browse") return;
    if (event.scroll?.direction === "up") move(-1);
    else if (event.scroll?.direction === "down") move(1);
  };

  const authorRows = groups.slice(authorWin, authorWin + authorViewport).map((group, index) => {
    const itemIndex = authorWin + index;
    const selected = itemIndex === authorIndex;
    const count = group.skills.length;
    const status = group.enabledCount === null ? `${count}` : `${group.enabledCount}/${count}`;
    return (
      <TextLine
        key={group.label}
        fg={selected && panel === "authors" ? colors.selectedText : colors.text}
        bg={selected ? colors.selectedBg : undefined}
        onMouseDown={clickAuthorRow(itemIndex)}
      >
        <span> </span>
        <span attributes={selected && panel === "authors" ? TextAttributes.BOLD : 0}>{fitCell(group.label, authorLabelW)}</span>
        <span fg={colors.yellow}>{group.hasDrift ? " ⚠" : "  "}</span>
        <span fg={selected && panel === "authors" ? colors.count : colors.muted}>{fitCell(status, 5, "right")}</span>
        <span> </span>
      </TextLine>
    );
  });

  const skillRows = (currentGroup?.skills ?? []).slice(skillWin, skillWin + skillViewport).map((item, index) => {
    const itemIndex = skillWin + index;
    const selected = itemIndex === skillIndex;
    const focusedRow = selected && panel === "skills";
    const fg = focusedRow ? colors.selectedText : colors.text;
    const bg = selected ? colors.selectedBg : undefined;
    const bold = focusedRow ? TextAttributes.BOLD : 0;
    const onMouseDown = clickSkillRow(itemIndex);
    if (item.kind === "project-skill") {
      return (
        <TextLine key={`p:${item.skill.name}`} fg={fg} bg={bg} onMouseDown={onMouseDown}>
          <span> </span>
          <span attributes={bold}>{fitCell(item.skill.name, skillLabelW)}</span>
          <span fg={colors.yellow}>{fitCell("project", 24, "right")}</span>
          <span> </span>
        </TextLine>
      );
    }
    if (item.kind === "unindexed-skill") {
      return (
        <TextLine key={`u:${item.skill.path}`} fg={fg} bg={bg} onMouseDown={onMouseDown}>
          <span> </span>
          <span attributes={bold}>{fitCell(item.skill.name, skillLabelW)}</span>
          <span fg={colors.yellow}>{fitCell("unindexed", 24, "right")}</span>
          <span> </span>
        </TextLine>
      );
    }
    const row = item.row;
    const placement = placementCell(projectPlacement(row));
    return (
      <TextLine key={row.name} fg={fg} bg={bg} onMouseDown={onMouseDown}>
        <span> </span>
        <span attributes={bold}>{fitCell(row.name, skillLabelW)}</span>
        <span fg={row.enabled ? colors.green : colors.muted}>{fitCell(row.enabled ? "on" : "off", 5, "right")}</span>
        <span fg={liveColor(row.live)}>{fitCell(liveLabel[row.live], 7, "right")}</span>
        <span fg={placement.fg}>{fitCell(placement.label, 9, "right")}</span>
        <span fg={upstreamCell(row).fg}>{fitCell(upstreamCell(row).label, 3, "right")}</span>
        <span> </span>
      </TextLine>
    );
  });

  // A committed filter lives in the pane title; while typing it takes over the footer.
  const filterTitle = filterText && !filterMode ? `/ ${filterText}` : undefined;
  const findTitle = docFind.query && !docFind.typing ? `/ ${docFind.query} · ${docMatches.length} match${docMatches.length === 1 ? "" : "es"}` : undefined;

  const footer = filterMode ? (
    <TextLine>
      <span fg={colors.accent}>{" / "}</span>
      <span>{filterText}</span>
      <span bg={colors.accent} fg={colors.background}>
        {" "}
      </span>
      <span fg={colors.muted}>{`  ${matchCount} match${matchCount === 1 ? "" : "es"}`}</span>
    </TextLine>
  ) : docFind.typing ? (
    <TextLine>
      <span fg={colors.accent}>{" / "}</span>
      <span>{docFind.query}</span>
      <span bg={colors.accent} fg={colors.background}>
        {" "}
      </span>
      <span fg={colors.muted}>{docFind.query ? `  ${docMatches.length} match${docMatches.length === 1 ? "" : "es"} in document` : "  search the document"}</span>
    </TextLine>
  ) : flash ? (
    <TextLine fg={flash.error ? colors.error : colors.count}>{` ${flash.text}`}</TextLine>
  ) : (
    <HintRow
      leading=" "
      items={[
        { key: "h/l", label: "pane" },
        { key: "tab", label: "next" },
        { key: "j/k", label: panel === "content" ? "scroll" : "move" },
        { key: "x", label: expanded ? "restore" : "zoom" },
        { key: "v/V", label: "layout" },
        { key: "</>", label: "size", when: twoPane !== null && !expanded },
        { key: "[/]", label: "file", when: showContent && previewData !== null && panel !== "authors" },
        { key: "space", label: "toggle", when: (panel === "authors" && currentGroup?.rows !== null) || (panel === "skills" && current !== undefined) },
        { key: "a", label: "index", when: currentUnindexedSkill !== undefined },
        { key: "e", label: "edit", when: editableSkillPath !== null },
        { key: "i", label: "details" },
        { key: "1/2", label: "view" },
        { key: "/", label: panel === "content" ? "search" : "filter" },
        { key: "n/N", label: "match", when: docFind.query.length > 0 },
        { key: "?", label: "help" },
        { key: "q", label: "quit" },
      ]}
    />
  );

  const overlay = (() => {
    switch (interaction.kind) {
      case "browse":
        return null;
      case "help":
        return <HelpModal cols={cols} rows={rowsAvail} editor={catalog.editorCommand[0]} />;
      case "detail":
        switch (interaction.item.kind) {
          case "skill":
            return <DetailModal cols={cols} rows={rowsAvail} row={interaction.item.row} catalog={catalog} />;
          case "project-skill":
            return <ProjectSkillModal cols={cols} rows={rowsAvail} skill={interaction.item.skill} catalog={catalog} />;
          case "unindexed-skill":
            return <UnindexedSkillModal cols={cols} rows={rowsAvail} skill={interaction.item.skill} />;
          default:
            return assertNever(interaction.item);
        }
      case "profiles":
        return <ProfilesModal cols={cols} rows={rowsAvail} catalog={catalog} names={profileNames} index={interaction.index} />;
      case "theme":
        return <ThemeModal cols={cols} rows={rowsAvail} index={interaction.index} saved={interaction.saved} />;
      case "diff":
        return <DiffModal cols={cols} rows={rowsAvail} row={interaction.row} result={interaction.result} />;
      case "link":
        return <LinkModal cols={cols} rows={rowsAvail} row={interaction.row} flow={interaction.flow} recents={catalog.state.recentProjects} />;
      case "index":
        return <IndexSkillModal cols={cols} rows={rowsAvail} skill={interaction.skill} flow={interaction.flow} />;
      default:
        return assertNever(interaction);
    }
  })();

  // Panes in display order, with their content widths. Rails go between them,
  // and the rails above/below the body meet each rail with ┬ / ┴.
  const panes: Array<{ key: Panel; width: number; node: ReactNode }> = [];
  if (showAuthors) {
    panes.push({
      key: "authors",
      width: authorsWidth,
      node: (
        <box width={authorsWidth} height={viewport} flexDirection="column" onMouseDown={clickPanel("authors")} onMouseScroll={wheelList(moveAuthor)}>
          <PaneTitle title="authors" detail={groups.length ? `${authorIndex + 1}/${groups.length}` : undefined} focused={panel === "authors"} />
          {authorRows}
          {groups.length === 0 ? <TextLine fg={colors.muted}>{" - No authors."}</TextLine> : null}
        </box>
      ),
    });
  }
  if (showSkills) {
    const detail = [currentGroup ? `· ${currentGroup.label}` : "", filterTitle ?? ""].filter(Boolean).join("  ");
    panes.push({
      key: "skills",
      width: skillsWidth,
      node: (
        <box width={skillsWidth} height={viewport} flexDirection="column" onMouseDown={clickPanel("skills")} onMouseScroll={wheelList(moveSkill)}>
          <PaneTitle title="skills" detail={detail || undefined} focused={panel === "skills"} />
          {skillRows}
          {matchCount === 0 ? <TextLine fg={colors.muted}>{filterText ? " - No skills match." : " - No skills."}</TextLine> : null}
        </box>
      ),
    });
  }
  if (showContent) {
    panes.push({
      key: "content",
      width: contentWidth,
      node: (
        <PreviewPanel
          data={previewData}
          skill={currentName}
          panel={panel}
          scrollRef={previewScroll}
          docRef={previewDoc}
          restoreScroll={previewRestore}
          syntaxStyle={syntaxStyle}
          width={contentWidth}
          fileTreeWidth={fileTreeW}
          fileTreeMode={fileTreeMode}
          height={viewport}
          findTitle={findTitle}
          onFocusPanel={(target) => clickPanel(target)()}
          onSelectFile={(index) => {
            if (interaction.kind === "browse") selectFile(index);
          }}
          onScrollFiles={(delta) => {
            if (interaction.kind === "browse") moveFile(delta);
          }}
        />
      ),
    });
  }
  const paneRailColumns: number[] = [];
  {
    let column = 0;
    panes.forEach((pane, index) => {
      if (index > 0) paneRailColumns.push(column);
      column += pane.width + (index > 0 ? 1 : 0);
    });
    // The rail between document and file tree also meets the body rails.
    if (showContent && previewData && fileTreeMode === "split") {
      const contentLeft = column - contentWidth;
      paneRailColumns.push(contentLeft + Math.max(1, contentWidth - fileTreeW - 1));
    }
  }
  const tabRailSet = new Set(tabRailColumns);
  const belowTabsJunctions: Junction[] = [...tabRailColumns.map((at) => ({ at, char: "┴" })), ...paneRailColumns.map((at) => ({ at, char: tabRailSet.has(at) ? "┼" : "┬" }))];

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={colors.background}>
      {header}
      <Divider width={cols} junctions={tabRailColumns.map((at) => ({ at, char: "┬" }))} />
      {tabs}
      <Divider width={cols} junctions={belowTabsJunctions} />
      <box height={viewport} flexDirection="row">
        {panes.flatMap((pane, index) => [...(index > 0 ? [<SeparatorColumn key={`rail-${pane.key}`} height={viewport} />] : []), <box key={pane.key}>{pane.node}</box>])}
      </box>
      <Divider width={cols} junctions={paneRailColumns.map((at) => ({ at, char: "┴" }))} />
      {footer}
      {overlay}
    </box>
  );
}

// ---- preview ---------------------------------------------------------------

function PreviewPanel({
  data,
  skill,
  panel,
  scrollRef,
  docRef,
  restoreScroll,
  syntaxStyle,
  width,
  fileTreeWidth,
  fileTreeMode,
  height,
  findTitle,
  onFocusPanel,
  onSelectFile,
  onScrollFiles,
}: {
  data: { files: string[]; idx: number; file: string; content: string } | null;
  skill: string | undefined;
  panel: Panel;
  scrollRef: { current: ScrollBoxRenderable | null };
  docRef: { current: DocRenderable | null };
  restoreScroll: number;
  syntaxStyle: ReturnType<typeof createMarkdownSyntax>;
  width: number;
  fileTreeWidth: number;
  fileTreeMode: "split" | "hidden" | "only";
  height: number;
  findTitle: string | undefined;
  onFocusPanel: (panel: "content" | "files") => void;
  onSelectFile: (index: number) => void;
  onScrollFiles: (delta: number) => void;
}) {
  const treeOnly = fileTreeMode === "only";

  useEffect(() => {
    if (treeOnly || restoreScroll === 0) return;
    const restore = () => scrollRef.current?.scrollTo(restoreScroll);
    restore();
    const timer = setTimeout(restore, 0);
    return () => clearTimeout(timer);
  }, [data?.file, restoreScroll, scrollRef, treeOnly]);

  const focused = panel === "content" || panel === "files";
  if (!data || !skill) {
    const top = Math.max(0, Math.floor((height - 1) / 2) - 1);
    return (
      <box width={width} height={height} flexDirection="column" onMouseDown={() => onFocusPanel("content")}>
        <PaneTitle title="document" focused={focused} />
        <Filler rows={top} />
        <PlainLine text={centerCell("No skill selected", width)} fg={colors.count} bold />
        <PlainLine text={centerCell("Use j/k to move", width)} fg={colors.muted} />
      </box>
    );
  }
  const treeRows = fileTreeRows(data.files);
  const treeIndex = Math.max(
    0,
    treeRows.findIndex((row) => row.kind === "file" && row.path === data.file),
  );
  const treeViewport = Math.max(1, height - 1);
  const treeWin = windowOf(0, treeIndex, treeRows.length, treeViewport);
  const extension = extname(data.file).slice(1).toLowerCase();
  const markdown = extension === "md" || extension === "mdx";
  const content = markdown ? markdownBody(data.file, data.content) : data.content;
  const showTree = fileTreeMode !== "hidden";
  const treeW = treeOnly ? width : fileTreeWidth;
  const docW = treeOnly ? 0 : showTree ? Math.max(1, width - treeW - 1) : width;
  const docDetail = [treeOnly ? "" : `· ${data.file}`, findTitle ?? ""].filter(Boolean).join("  ");

  const tree = showTree ? (
    <box
      width={treeW}
      height={height}
      flexDirection="column"
      onMouseDown={(event) => {
        event.stopPropagation();
        onFocusPanel("files");
      }}
      onMouseScroll={(event) => {
        event.stopPropagation();
        if (event.scroll?.direction === "up") onScrollFiles(-1);
        else if (event.scroll?.direction === "down") onScrollFiles(1);
      }}
    >
      <PaneTitle title="files" detail={`${data.idx + 1}/${data.files.length}`} focused={panel === "files"} />
      {treeRows.slice(treeWin, treeWin + treeViewport).map((row) => {
        const selected = row.kind === "file" && row.path === data.file;
        const fileIndex = row.kind === "file" ? data.files.indexOf(row.path) : -1;
        return (
          <TextLine
            key={`${row.kind}:${row.path}`}
            fg={row.kind === "folder" ? colors.muted : selected && panel === "files" ? colors.selectedText : colors.text}
            bg={selected ? colors.selectedBg : undefined}
            onMouseDown={(event) => {
              event.stopPropagation();
              onFocusPanel("files");
              if (fileIndex !== -1) onSelectFile(fileIndex);
            }}
          >
            <span>{` ${"  ".repeat(row.depth)}`}</span>
            <span fg={row.kind === "folder" ? colors.separator : undefined}>{row.kind === "folder" ? "▾ " : "  "}</span>
            <span attributes={selected && panel === "files" ? TextAttributes.BOLD : 0}>{fitCell(row.label, Math.max(1, treeW - 4 - row.depth * 2))}</span>
            <span> </span>
          </TextLine>
        );
      })}
    </box>
  ) : null;

  return (
    <box width={width} height={height} flexDirection="row" onMouseDown={() => onFocusPanel("content")}>
      {!treeOnly ? (
        <box width={docW} height={height} flexDirection="column">
          <PaneTitle title="document" detail={docDetail || undefined} focused={panel === "content"} />
          <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} viewportOptions={{ paddingRight: 1 }} verticalScrollbarOptions={{ visible: false }}>
            {markdown ? (
              <markdown
                ref={(node) => {
                  docRef.current = node;
                }}
                width="100%"
                content={content}
                syntaxStyle={syntaxStyle}
                // Kept on deliberately, against the usual "finalize when the
                // content stops arriving" advice. Content here arrives whole,
                // but streaming is also what paints before tree-sitter returns:
                // measured 6ms to first paint with it, 131ms without. Selecting
                // a skill must not blank the pane for an eighth of a second.
                // The documented cost is that the last two blocks stay marked
                // unstable, which only affects _stableBlockCount and the
                // scrollback commit APIs this pane does not use.
                streaming
                internalBlockMode="top-level"
                tableOptions={{ style: "grid", widthMode: "full", wrapMode: "word" }}
                conceal
                fg={colors.text}
                bg={colors.background}
              />
            ) : (
              <code
                ref={(node) => {
                  docRef.current = node;
                }}
                width="100%"
                content={content}
                filetype={extension || "text"}
                syntaxStyle={syntaxStyle}
                wrapMode="none"
                drawUnstyledText
              />
            )}
          </scrollbox>
        </box>
      ) : null}
      {!treeOnly && showTree ? <SeparatorColumn height={height} /> : null}
      {tree}
    </box>
  );
}
