/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef, useState } from "react";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Match } from "effect";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { acceptVendorDrift, applyProfile, linkProjectSkill, restoreVendorDrift, setSkillsEnabled } from "../lib/catalogActions.ts";
import type { ActionResult } from "../lib/catalogActions.ts";
import { isClean, pagePatch, unifiedDiff } from "../lib/diff.ts";
import type { DiffPager, DirDiff } from "../lib/diff.ts";
import { formatUtc, getProfile } from "../lib/manifest.ts";
import { addSkillFromSource, parseSkillsAddSource } from "../lib/skillsAdd.ts";
import { checkUpstream } from "../lib/update.ts";
import type { UnindexedSkill } from "../lib/adopt.ts";
import { runPromiseResult, runSync, runSyncResult } from "./runtime.ts";
import { Hint, Modal, TextLine } from "./components.tsx";
import { colors, createMarkdownSyntax } from "./theme.ts";
import { clamp, fileTreeRows, fitCell, markdownBody, markdownHeadingLines, printable, searchMatchLines, singleLinePaste, windowOf } from "./util.ts";
import { scrollRowForLine } from "./docNav.ts";
import type { DocRenderable } from "./docNav.ts";
import { copySelection, handleSelectionKey } from "./clipboard.ts";
import { editableHostSkillPath, editSkillInNvim, withSuspendedRenderer } from "./external.ts";
import { cycleLayout, primaryPanel, resizeFocusedSplit } from "./layout.ts";
import type { Panel, PrimaryPanel, TwoPanePair } from "./layout.ts";
import {
  diffSkill,
  expandHome,
  isSkillAvailableHere,
  linksForSkill,
  loadCatalog,
  projectSkillDescription,
  projectSkillFiles,
  projectSkillPath,
  projectPlacement,
  readProjectSkillFile,
  readSkillFile,
  readUnindexedSkillFile,
  skillDescription,
  skillFiles,
  unindexedSkillDescription,
  unindexedSkillFiles,
  verifyRow,
} from "./data.ts";
import type { Catalog, CatalogRow, DiffResult, LiveStatus, ProjectPlacement, ProjectSkill } from "./data.ts";

type Mode = "list" | "help" | "detail" | "profiles" | "diff" | "link" | "index";
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

interface LinkFlow {
  step: "project" | "mode" | "options";
  input: string;
  recentIndex: number; // -1 = free text
  mode: "copy" | "symlink";
  exclude: boolean;
  claude: boolean;
  error?: string;
}

interface IndexFlow {
  input: string;
  running: boolean;
  error?: string;
}

const liveColor = {
  ok: colors.green,
  drift: colors.yellow,
  missing: colors.red,
  off: colors.muted,
  stale: colors.yellow,
  checking: colors.muted,
} satisfies Record<LiveStatus, string>;

const liveLabel = {
  ok: "ok",
  drift: "drift",
  missing: "missing",
  off: "-",
  stale: "stale",
  checking: "\u2026",
} satisfies Record<LiveStatus, string>;

const placementCell = {
  none: { label: "-", fg: colors.muted },
  "link-hidden": { label: "link·hid", fg: colors.accent },
  "link-tracked": { label: "link·git", fg: colors.accent },
  "copy-hidden": { label: "copy·hid", fg: colors.accent },
  "copy-tracked": { label: "copy·git", fg: colors.accent },
  missing: { label: "missing", fg: colors.red },
  unmanaged: { label: "unmanaged", fg: colors.yellow },
} satisfies Record<ProjectPlacement, { label: string; fg: string }>;

export function App() {
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
  const [mode, setMode] = useState<Mode>("list");
  const [filterMode, setFilterMode] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [docFind, setDocFind] = useState<{ typing: boolean; query: string }>({ typing: false, query: "" });
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null);
  const [profileIndex, setProfileIndex] = useState(0);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [linkFlow, setLinkFlow] = useState<LinkFlow | null>(null);
  const [indexFlow, setIndexFlow] = useState<IndexFlow | null>(null);
  const [previewState, setPreviewState] = useState<{ skill: string | null; file: number; restore: number }>({ skill: null, file: 0, restore: 0 });

  const quitting = useRef(false);
  const pendingG = useRef(0);
  const previewScroll = useRef<ScrollBoxRenderable | null>(null);
  const previewDoc = useRef<DocRenderable | null>(null);
  const findPos = useRef(-1);
  const syntaxStyle = useMemo(() => createMarkdownSyntax(), []);

  useEffect(() => () => syntaxStyle.destroy(), [syntaxStyle]);

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
    const keys = [...byOwner.keys()].sort((a, b) => (a === "local" ? -1 : b === "local" ? 1 : a < b ? -1 : 1));
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

  const viewport = Math.max(3, rowsAvail - 4 - (filterMode || filterText ? 1 : 0) - (docFind.typing || docFind.query ? 1 : 0));
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
    if (!current && !currentProjectSkill && !currentUnindexedSkill) return null;
    const files = current
      ? skillFiles(catalog.repo, current.meta)
      : currentProjectSkill
        ? projectSkillFiles(catalog.project, currentProjectSkill)
        : currentUnindexedSkill
          ? unindexedSkillFiles(currentUnindexedSkill)
          : [];
    if (files.length === 0) return null;
    const idx = clamp(previewFile, 0, files.length - 1);
    const file = files[idx] ?? "SKILL.md";
    const content = current
      ? readSkillFile(catalog.repo, current.meta, file)
      : currentProjectSkill
        ? readProjectSkillFile(catalog.project, currentProjectSkill, file)
        : currentUnindexedSkill
          ? readUnindexedSkillFile(currentUnindexedSkill, file)
          : "";
    return { files, idx, file, content };
  }, [current, currentProjectSkill, currentUnindexedSkill, catalog.project, catalog.repo, previewFile]);

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
      const verified = verifyRow(catalog.agentsSkills, row);
      setCatalog((previous) => ({
        ...previous,
        rows: previous.rows.map((candidate) => (candidate.name === verified.name && candidate.live === "checking" ? verified : candidate)),
      }));
    }, 0);
    return () => clearTimeout(timer);
  }, [catalog.rows, catalog.agentsSkills]);

  const refresh = () => {
    setCatalog(runSync(loadCatalog()));
  };

  const notify = (text: string, error = false) => {
    setFlash({ text, error });
    const snapshot = text;
    setTimeout(() => {
      setFlash((cur) => (cur?.text === snapshot ? null : cur));
    }, 3000);
  };
  const copyActiveSelection = () => copySelection(renderer, { notify });

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

  const handleOverlay = (key: KeyEvent): boolean => {
    if (mode === "list") return false;
    if (mode === "link" && linkFlow) return handleLink(key);
    if (mode === "index" && indexFlow) return handleIndex(key);
    if (key.name === "escape" || key.name === "q") {
      setMode("list");
      return true;
    }
    if (mode === "diff" && current && diffResult?.kind === "diff" && !isClean(diffResult.diff)) {
      if (key.name === "a") {
        const outcome = runSyncResult(acceptVendorDrift(current.name));
        if (outcome.ok) {
          const warning = outcome.value.warning;
          notify(warning ? `accepted ${current.name}: ${warning.message}` : `accepted global ${current.name} as the repo baseline`, warning !== undefined);
          refresh();
          setMode("list");
        } else {
          notify(outcome.message, true);
        }
        return true;
      }
      if (key.name === "r") {
        const outcome = runSyncResult(restoreVendorDrift(current.name));
        if (outcome.ok) {
          notify(`restored global ${current.name} from the repo baseline`);
          refresh();
          setMode("list");
        } else {
          notify(outcome.message, true);
        }
        return true;
      }
      const pager: DiffPager | undefined = key.name === "h" ? "hunk" : key.name === "d" ? "delta" : undefined;
      if (pager) {
        let suspended = false;
        try {
          const patch = unifiedDiff(join(catalog.repo, current.meta.path), join(catalog.agentsSkills, current.name));
          renderer.suspend();
          suspended = true;
          pagePatch(patch, pager);
        } catch (error) {
          notify(`${pager} failed: ${error instanceof Error ? error.message : String(error)}`, true);
        } finally {
          if (suspended) renderer.resume();
        }
        return true;
      }
    }
    if (mode === "profiles") {
      if (key.name === "j" || key.name === "down") {
        setProfileIndex((i) => clamp(i + 1, 0, profileNames.length - 1));
        return true;
      }
      if (key.name === "k" || key.name === "up") {
        setProfileIndex((i) => clamp(i - 1, 0, profileNames.length - 1));
        return true;
      }
      if (key.name === "return" || key.name === "enter") {
        const name = profileNames[profileIndex];
        if (name) {
          reportAction(`profile ${name}`, runSync(applyProfile(name)));
          refresh();
        }
        setMode("list");
        return true;
      }
    }
    if (key.name === "?" && mode === "help") {
      setMode("list");
      return true;
    }
    return true; // overlays swallow everything else
  };

  const patchFlow = (fn: (prev: LinkFlow) => LinkFlow) => setLinkFlow((prev) => (prev ? fn(prev) : prev));

  const patchIndexFlow = (fn: (prev: IndexFlow) => IndexFlow) => setIndexFlow((prev) => (prev ? fn(prev) : prev));

  const handleIndex = (key: KeyEvent): boolean => {
    if (!indexFlow || !currentUnindexedSkill) return true;
    if (indexFlow.running) return true;
    if (key.name === "escape") {
      setIndexFlow(null);
      setMode("list");
      return true;
    }
    if (key.name === "backspace") {
      patchIndexFlow((flow) => ({ ...flow, input: flow.input.slice(0, -1), error: undefined }));
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      let source: string;
      try {
        source = parseSkillsAddSource(indexFlow.input, currentUnindexedSkill.name);
      } catch (error) {
        patchIndexFlow((flow) => ({ ...flow, error: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      const skill = currentUnindexedSkill;
      patchIndexFlow((flow) => ({ ...flow, running: true, error: undefined }));
      setTimeout(() => {
        const outcome = runSyncResult(addSkillFromSource(source, skill.name, { unindexedSkill: skill }));
        if (outcome.ok) {
          const result = outcome.value;
          setIndexFlow(null);
          setMode("list");
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
    if (!linkFlow || !current) return true;
    if (key.name === "escape") {
      setLinkFlow(null);
      setMode("list");
      return true;
    }
    if (linkFlow.step === "project") {
      const recents = catalog.state.recentProjects;
      if (key.name === "up" || key.name === "down") {
        if (recents.length === 0) return true;
        const dir = key.name === "down" ? 1 : -1;
        patchFlow((f) => {
          const next = clamp(f.recentIndex + dir, 0, recents.length - 1);
          return { ...f, recentIndex: next, input: recents[next] ?? f.input };
        });
        return true;
      }
      if (key.name === "return" || key.name === "enter") {
        patchFlow((f) => {
          const path = expandHome(f.input.trim());
          if (!path || !existsSync(path)) {
            return { ...f, error: `not a directory: ${path || "(empty)"}` };
          }
          return { ...f, input: path, step: "mode", error: undefined };
        });
        return true;
      }
      if (key.name === "backspace") {
        patchFlow((f) => ({ ...f, input: f.input.slice(0, -1), recentIndex: -1 }));
        return true;
      }
      const p = printable(key);
      if (p) patchFlow((f) => ({ ...f, input: f.input + p, recentIndex: -1 }));
      return true;
    }
    if (linkFlow.step === "mode") {
      if (key.name === "j" || key.name === "k" || key.name === "up" || key.name === "down") {
        patchFlow((f) => ({ ...f, mode: f.mode === "copy" ? "symlink" : "copy" }));
        return true;
      }
      if (key.name === "c") {
        patchFlow((f) => ({ ...f, mode: "copy" }));
        return true;
      }
      if (key.name === "s") {
        patchFlow((f) => ({ ...f, mode: "symlink" }));
        return true;
      }
      if (key.name === "return" || key.name === "enter") {
        patchFlow((f) => ({ ...f, step: "options" }));
        return true;
      }
      return true;
    }
    // options
    if (key.name === "e") {
      patchFlow((f) => ({ ...f, exclude: !f.exclude }));
      return true;
    }
    if (key.name === "c") {
      patchFlow((f) => ({ ...f, claude: !f.claude }));
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      const outcome = runSyncResult(
        linkProjectSkill({
          skill: current.name,
          project: linkFlow.input,
          mode: linkFlow.mode,
          gitExclude: linkFlow.exclude,
          claude: linkFlow.claude,
        }),
      );
      if (outcome.ok) notify(`linked ${current.name} (${linkFlow.mode}) into ${linkFlow.input}`);
      else notify(outcome.message, true);
      setLinkFlow(null);
      setMode("list");
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
      const reason =
        panel === "authors"
          ? "focus the skill or document pane first"
          : current?.origin === "vendor" || currentUnindexedSkill?.origin === "vendor"
            ? "vendor baselines must be changed through update and vendor"
            : currentUnindexedSkill?.origin === "agent"
              ? "the staging inbox can be overwritten; index the skill before editing"
              : "project-only skills are outside the skills host";
      notify(`cannot edit here: ${reason}`, true);
      return;
    }
    try {
      withSuspendedRenderer(renderer, () => editSkillInNvim(catalog.repo, editableSkillPath));
      refresh();
      notify(
        current ? `edited ${current.name} · run slinky rehash ${current.name} before saving` : `edited ${currentUnindexedSkill?.name ?? "skill"} · press a to index it when ready`,
      );
    } catch (error) {
      notify(`nvim failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };

  const handleList = (key: KeyEvent): void => {
    const panelOrder: Panel[] =
      twoPane === "catalog"
        ? ["authors", "skills"]
        : twoPane === "document"
          ? previewData
            ? ["skills", "content", "files"]
            : ["skills", "content"]
          : previewData
            ? ["authors", "skills", "content", "files"]
            : ["authors", "skills", "content"];
    const movePanel = (delta: number) => {
      const index = Math.max(0, panelOrder.indexOf(panel));
      focusPanel(panelOrder[clamp(index + delta, 0, panelOrder.length - 1)] ?? panel);
    };
    const focusedPrimary = primaryPanel(panel);

    if (key.name === "q" || (key.ctrl && key.name === "c")) return quit();
    if (key.name === "1") return switchCatalogView("available");
    if (key.name === "2") return switchCatalogView("all");
    if (key.name === "tab") {
      const index = Math.max(0, panelOrder.indexOf(panel));
      focusPanel(panelOrder[(index + 1) % panelOrder.length] ?? "authors");
      return;
    }
    if (key.name === "left" || (key.name === "h" && !key.shift)) return movePanel(-1);
    if (key.name === "right" || (key.name === "l" && !key.shift)) return movePanel(1);
    if (key.name === "0") {
      focusPanel("authors");
      return;
    }
    if (key.name === "$" || (key.name === "4" && key.shift)) {
      focusPanel(panelOrder.at(-1) ?? "skills");
      return;
    }
    if (key.name === "x") {
      setExpanded((value) => (value === focusedPrimary ? null : focusedPrimary));
      return;
    }
    if (key.name === "v") {
      cyclePaneLayout(key.shift ? -1 : 1);
      return;
    }
    if (key.name === "escape") {
      if (expanded) setExpanded(null);
      else if (twoPane) setTwoPane(null);
      else if (docFind.query) setDocFind({ typing: false, query: "" });
      else if (filterText) setFilterText("");
      return;
    }
    const shrinkFocusedPane = key.name === "<" || (key.name === "," && key.shift);
    const growFocusedPane = key.name === ">" || (key.name === "." && key.shift);
    if (twoPane && !expanded && (shrinkFocusedPane || growFocusedPane)) {
      const grow = growFocusedPane;
      if (twoPane === "catalog") setCatalogSplit((split) => resizeFocusedSplit(split, twoPane, panel, grow));
      else setDocumentSplit((split) => resizeFocusedSplit(split, twoPane, panel, grow));
      return;
    }
    if (key.name === "}" || (key.name === "]" && key.shift)) return jumpHeading(1);
    if (key.name === "{" || (key.name === "[" && key.shift)) return jumpHeading(-1);
    if (previewData && key.name === "]" && !key.shift) return moveFile(1);
    if (previewData && key.name === "[" && !key.shift) return moveFile(-1);
    if ((key.name === "j" && key.shift) || key.name === "pagedown") {
      previewScroll.current?.scrollBy(key.name === "pagedown" ? viewport - 3 : 3);
      return;
    }
    if ((key.name === "k" && key.shift) || key.name === "pageup") {
      previewScroll.current?.scrollBy(key.name === "pageup" ? -(viewport - 3) : -3);
      return;
    }
    if (key.ctrl && key.name === "e") {
      previewScroll.current?.scrollBy(1);
      return;
    }
    if (key.ctrl && key.name === "y") {
      previewScroll.current?.scrollBy(-1);
      return;
    }

    const moveFocused = (delta: number) => {
      if (panel === "authors") moveAuthor(delta);
      else if (panel === "skills") moveSkill(delta);
      else if (panel === "files") moveFile(delta);
      else previewScroll.current?.scrollBy(delta);
    };
    if ((key.name === "j" && !key.shift) || key.name === "down") return moveFocused(1);
    if ((key.name === "k" && !key.shift) || key.name === "up") return moveFocused(-1);
    if (key.ctrl && key.name === "d") return moveFocused(Math.floor(viewport / 2));
    if (key.ctrl && key.name === "u") return moveFocused(-Math.floor(viewport / 2));
    if (key.ctrl && key.name === "f") return moveFocused(Math.max(1, viewport - 2));
    if (key.ctrl && key.name === "b") return moveFocused(-Math.max(1, viewport - 2));
    if (key.name === "g" && !key.shift) {
      const now = Date.now();
      if (now - pendingG.current < 500) {
        if (panel === "authors") setSelectedAuthor(0);
        else if (panel === "skills") setSelectedSkill(0);
        else if (panel === "files") setPreviewState({ skill: currentName ?? null, file: 0, restore: 0 });
        else previewScroll.current?.scrollTo(0);
        pendingG.current = 0;
      } else {
        pendingG.current = now;
      }
      return;
    }
    if (key.name === "g" && key.shift) {
      if (panel === "authors") setSelectedAuthor(Math.max(0, groups.length - 1));
      else if (panel === "skills") setSelectedSkill(Math.max(0, (currentGroup?.skills.length ?? 1) - 1));
      else if (panel === "files") setPreviewState({ skill: currentName ?? null, file: Math.max(0, (previewData?.files.length ?? 1) - 1), restore: 0 });
      else previewScroll.current?.scrollTo(previewScroll.current.scrollHeight);
      return;
    }
    if (key.name === "/") {
      if (panel === "content" && previewData) {
        setDocFind({ typing: true, query: "" });
        return;
      }
      setFilterMode(true);
      setFilterText("");
      return;
    }
    if (key.name === "n" && !key.shift) return jumpMatch(1);
    if (key.name === "n" && key.shift) return jumpMatch(-1);
    if (key.name === "r") {
      refresh();
      notify("refreshed");
      return;
    }
    if (key.name === "e") {
      editCurrentSkill();
      return;
    }
    if (key.name === "?") return setMode("help");
    if (key.name === "u") {
      notify("checking upstream\u2026");
      void (async () => {
        const outcome = await runPromiseResult(checkUpstream(runSync(loadCatalog()).manifest));
        if (!outcome.ok) {
          notify(`upstream check failed: ${outcome.message}`, true);
          return;
        }
        const statuses = outcome.value;
        const byName = new Map(statuses.map((s) => [s.name, s.state]));
        setCatalog((prev) => ({
          ...prev,
          rows: prev.rows.map((r) => {
            const state = byName.get(r.name);
            return state ? { ...r, upstream: state } : r;
          }),
        }));
        const updates = statuses.filter((s) => s.state === "update").length;
        const gone = statuses.filter((s) => s.state === "gone").length;
        notify(updates + gone === 0 ? "upstream: everything current" : `upstream: ${updates} update(s), ${gone} gone \u2014 run slinky update`);
      })();
      return;
    }
    if (key.name === "p") {
      if (profileNames.length === 0) return notify("no profiles defined in skills.manifest.json", true);
      setProfileIndex(Math.max(0, profileNames.indexOf(catalog.state.activeProfile ?? "")));
      return setMode("profiles");
    }

    if (key.name === "return" || key.name === "enter") {
      if (panel === "authors") setPanel("skills");
      else if (panel === "skills" && twoPane === "catalog" && (current || currentProjectSkill || currentUnindexedSkill)) setMode("detail");
      else if (panel === "skills" || panel === "files") setPanel("content");
      else if (current || currentProjectSkill || currentUnindexedSkill) setMode("detail");
      return;
    }
    if (key.name === "space") {
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
        return;
      }
      if (panel !== "skills") return;
      if (!current) return;
      const res = runSync(setSkillsEnabled([current.name], !current.enabled));
      reportAction(`${current.enabled ? "disabled" : "enabled"} ${current.name}`, res);
      refresh();
      return;
    }
    if (key.name === "i" && (current || currentProjectSkill || currentUnindexedSkill)) return setMode("detail");
    if (key.name === "a" && currentUnindexedSkill) {
      setIndexFlow({ input: "", running: false });
      return setMode("index");
    }
    if (!current) return;
    if (key.name === "d") {
      setDiffResult(diffSkill(catalog, current));
      return setMode("diff");
    }
    if (key.name === "l" && key.shift) {
      // prefer the directory Slinky was launched from (unless it's the skills repo)
      const cwd = process.cwd();
      const defaultProject = cwd !== catalog.repo ? cwd : (catalog.state.recentProjects[0] ?? "");
      setLinkFlow({
        step: "project",
        input: defaultProject,
        recentIndex: -1,
        mode: "copy",
        exclude: true,
        claude: true,
      });
      return setMode("link");
    }
  };

  useKeyboard((key) => {
    if (key.eventType === "release" || (key.repeated === true && key.name === "g")) return;
    if (handleSelectionKey(renderer, key, { notify })) return;
    if (handleFilter(key)) return;
    if (handleFind(key)) return;
    if (handleOverlay(key)) return;
    handleList(key);
  });

  usePaste((event) => {
    if (mode !== "index" || !indexFlow || indexFlow.running) return;
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
  const authorW = Math.max(18, Math.min(25, Math.floor(cols * 0.19)));
  const skillW = Math.max(33, Math.min(42, Math.floor(cols * 0.31)));
  const catalogAuthorW = Math.max(18, Math.min(cols - 33, Math.floor(cols * catalogSplit)));
  const catalogSkillW = cols - catalogAuthorW;
  const documentSkillW = Math.max(33, Math.min(cols - 30, Math.floor(cols * documentSplit)));
  const fileTreeW = Math.max(18, Math.min(28, Math.floor(cols * 0.21)));
  const authorViewport = Math.max(1, viewport - 2);
  const authorWin = windowOf(0, authorIndex, groups.length, authorViewport);
  const skillViewport = Math.max(1, viewport - 2);
  const skillWin = windowOf(0, skillIndex, currentGroup?.skills.length ?? 0, skillViewport);
  const authorsWidth = expanded === "authors" || narrow ? cols : twoPane === "catalog" ? catalogAuthorW : authorW;
  const skillsWidth = expanded === "skills" || narrow ? cols : twoPane === "catalog" ? catalogSkillW : twoPane === "document" ? documentSkillW : skillW;
  const authorLabelW = Math.max(4, authorsWidth - 10);
  const skillLabelW = Math.max(4, skillsWidth - 29);

  const upstreamCell = (row: CatalogRow): { label: string; fg: string } =>
    Match.value(row.upstream).pipe(
      Match.when("update", () => ({ label: "^", fg: colors.yellow })),
      Match.when("gone", () => ({ label: "×", fg: colors.red })),
      Match.when("current", () => ({ label: "=", fg: colors.muted })),
      Match.orElse(() => ({ label: "", fg: colors.muted })),
    );

  const header = (
    <box height={1} width="100%" flexDirection="row" justifyContent="space-between" backgroundColor={colors.headerBg}>
      <text wrapMode="none" truncate>
        <span fg={colors.accent}>{" slinky "}</span>
        <span fg={colors.muted}>{compactHeader ? "· " : " project: "}</span>
        <span fg={colors.text}>{projectName}</span>
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

  const tabs = (
    <box height={1} width="100%" flexDirection="row" justifyContent="space-between" backgroundColor={colors.panelBg}>
      <box height={1} flexDirection="row">
        <text
          wrapMode="none"
          truncate
          fg={catalogView === "available" ? colors.selectedText : colors.muted}
          bg={catalogView === "available" ? colors.selectedBg : undefined}
          marginLeft={1}
          onMouseDown={() => {
            if (mode === "list") switchCatalogView("available");
          }}
        >{` 1 ${compactHeader ? "available" : "available here"} ${availableCount} `}</text>
        <text
          wrapMode="none"
          truncate
          fg={catalogView === "all" ? colors.selectedText : colors.muted}
          bg={catalogView === "all" ? colors.selectedBg : undefined}
          marginLeft={1}
          onMouseDown={() => {
            if (mode === "list") switchCatalogView("all");
          }}
        >{` 2 ${compactHeader ? "all" : "all skills"} ${allCount} `}</text>
      </box>
      {catalog.state.activeProfile && !tiny ? <text fg={colors.muted} wrapMode="none" truncate>{`profile: ${catalog.state.activeProfile} `}</text> : null}
    </box>
  );

  // Mouse: click selects a row (and focuses its panel); wheel moves the selection.
  const clickAuthorRow = (index: number) => (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    if (mode !== "list") return;
    if (panel !== "authors") focusPanel("authors");
    setSelectedAuthor(index);
    setSelectedSkill(0);
  };
  const clickSkillRow = (index: number) => (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    if (mode !== "list") return;
    if (panel !== "skills") focusPanel("skills");
    setSelectedSkill(index);
  };
  const clickPanel = (target: Panel) => () => {
    if (mode !== "list") return;
    if (panel !== target) focusPanel(target);
  };
  const wheelList = (move: (delta: number) => void) => (event: { stopPropagation: () => void; scroll?: { direction: string } }) => {
    event.stopPropagation();
    if (mode !== "list") return;
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
        <span fg={selected ? colors.accent : colors.muted}>{selected ? " › " : "   "}</span>
        <span>{fitCell(group.label, authorLabelW)}</span>
        <span fg={colors.yellow}>{group.hasDrift ? " ⚠" : "  "}</span>
        <span fg={colors.muted}>{fitCell(status, 5, "right")}</span>
      </TextLine>
    );
  });

  const skillRows = (currentGroup?.skills ?? []).slice(skillWin, skillWin + skillViewport).map((item, index) => {
    const itemIndex = skillWin + index;
    const selected = itemIndex === skillIndex;
    const fg = selected && panel === "skills" ? colors.selectedText : colors.text;
    const bg = selected ? colors.selectedBg : undefined;
    const onMouseDown = clickSkillRow(itemIndex);
    if (item.kind === "project-skill") {
      return (
        <TextLine key={`p:${item.skill.name}`} fg={fg} bg={bg} onMouseDown={onMouseDown}>
          <span fg={selected ? colors.accent : colors.muted}>{selected ? " › " : "   "}</span>
          <span>{fitCell(item.skill.name, skillLabelW)}</span>
          <span fg={colors.yellow}>{fitCell("project", 9, "right")}</span>
        </TextLine>
      );
    }
    if (item.kind === "unindexed-skill") {
      return (
        <TextLine key={`u:${item.skill.path}`} fg={fg} bg={bg} onMouseDown={onMouseDown}>
          <span fg={selected ? colors.accent : colors.muted}>{selected ? " › " : "   "}</span>
          <span>{fitCell(item.skill.name, skillLabelW)}</span>
          <span fg={colors.yellow}>{fitCell("unindexed", 12, "right")}</span>
        </TextLine>
      );
    }
    const row = item.row;
    const placement = placementCell[projectPlacement(row)];
    return (
      <TextLine key={row.name} fg={fg} bg={bg} onMouseDown={onMouseDown}>
        <span fg={selected ? colors.accent : colors.muted}>{selected ? " › " : "   "}</span>
        <span>{fitCell(row.name, skillLabelW)}</span>
        <span fg={row.enabled ? colors.green : colors.muted}>{fitCell(row.enabled ? "on" : "off", 5, "right")}</span>
        <span fg={liveColor[row.live]}>{fitCell(liveLabel[row.live], 7, "right")}</span>
        <span fg={placement.fg}>{fitCell(placement.label, 9, "right")}</span>
        <span fg={upstreamCell(row).fg}>{fitCell(upstreamCell(row).label, 3, "right")}</span>
      </TextLine>
    );
  });

  const filterBar =
    filterMode || filterText ? (
      <TextLine fg={colors.text}>
        <span fg={colors.accent}>{" /"}</span>
        <span>{filterText}</span>
        <span fg={colors.accent}>{filterMode ? "\u2588" : ""}</span>
        <span fg={colors.muted}>{`  (${matchCount} match${matchCount === 1 ? "" : "es"})`}</span>
      </TextLine>
    ) : null;

  const findBar =
    docFind.typing || docFind.query ? (
      <TextLine fg={colors.text}>
        <span fg={colors.accent}>{" doc /"}</span>
        <span>{docFind.query}</span>
        <span fg={colors.accent}>{docFind.typing ? "\u2588" : ""}</span>
        <span fg={colors.muted}>{docFind.query ? `  (${docMatches.length} match${docMatches.length === 1 ? "" : "es"}${docFind.typing ? "" : " \u00b7 n/N to jump"})` : ""}</span>
      </TextLine>
    ) : null;

  const footer = flash ? (
    <TextLine fg={flash.error ? colors.red : colors.green}>{` ${flash.text}`}</TextLine>
  ) : (
    <TextLine>
      <span> </span>
      <Hint keys="h/l" label="pane" />
      <Hint keys="tab" label="next" />
      <Hint keys="j/k" label={panel === "content" ? "scroll" : "move"} />
      <Hint keys="x" label={expanded ? "restore" : "zoom"} />
      <Hint keys="v/V" label="layout" />
      {twoPane && !expanded ? <Hint keys="</>" label="size" /> : null}
      {showContent && previewData && panel !== "authors" ? <Hint keys="[/]" label="file" /> : null}
      {(panel === "authors" && currentGroup?.rows) || (panel === "skills" && current) ? <Hint keys="space" label="toggle" /> : null}
      {currentUnindexedSkill ? <Hint keys="a" label="index" /> : null}
      {editableSkillPath ? <Hint keys="e" label="edit" /> : null}
      <Hint keys="i" label="details" />
      <Hint keys="1/2" label="view" />
      <Hint keys="/" label={panel === "content" ? "search" : "filter"} />
      {docFind.query ? <Hint keys="n/N" label="match" /> : null}
      <Hint keys="?" label="help" />
      <Hint keys="q" label="quit" />
    </TextLine>
  );

  return (
    <box width="100%" height="100%" flexDirection="column" onMouseUp={copyActiveSelection}>
      {header}
      {tabs}
      {filterBar}
      {findBar}
      <box flexGrow={1} flexDirection="row" backgroundColor={colors.panelBg}>
        {showAuthors ? (
          <box
            width={authorsWidth}
            flexDirection="column"
            border
            borderStyle="single"
            borderColor={panel === "authors" ? colors.accent : colors.modalBorder}
            title={` authors ${groups.length ? `${authorIndex + 1}/${groups.length}` : ""} `}
            titleColor={panel === "authors" ? colors.accent : colors.muted}
            onMouseDown={clickPanel("authors")}
            onMouseScroll={wheelList(moveAuthor)}
          >
            {authorRows}
            {groups.length === 0 ? <TextLine fg={colors.muted}>{"  no authors"}</TextLine> : null}
          </box>
        ) : null}
        {showSkills ? (
          <box
            width={skillsWidth}
            flexDirection="column"
            border
            borderStyle="single"
            borderColor={panel === "skills" ? colors.accent : colors.modalBorder}
            title={` skills · ${currentGroup?.label ?? "-"} `}
            titleColor={panel === "skills" ? colors.accent : colors.muted}
            onMouseDown={clickPanel("skills")}
            onMouseScroll={wheelList(moveSkill)}
          >
            {skillRows}
            {matchCount === 0 ? <TextLine fg={colors.muted}>{"  no skills match"}</TextLine> : null}
          </box>
        ) : null}
        {showContent ? (
          <PreviewPanel
            data={previewData}
            skill={currentName}
            panel={panel}
            scrollRef={previewScroll}
            docRef={previewDoc}
            restoreScroll={previewRestore}
            syntaxStyle={syntaxStyle}
            fileTreeWidth={fileTreeW}
            fileTreeMode={tiny ? (panel === "files" ? "only" : "hidden") : "split"}
            height={viewport}
            onFocusPanel={(target) => clickPanel(target)()}
            onSelectFile={(index) => {
              if (mode === "list") selectFile(index);
            }}
            onScrollFiles={(delta) => {
              if (mode === "list") moveFile(delta);
            }}
          />
        ) : null}
      </box>
      {footer}
      {mode === "help" ? <HelpModal cols={cols} /> : null}
      {mode === "detail" && current ? <DetailModal cols={cols} row={current} catalog={catalog} /> : null}
      {mode === "detail" && currentProjectSkill ? <ProjectSkillModal cols={cols} skill={currentProjectSkill} catalog={catalog} /> : null}
      {mode === "detail" && currentUnindexedSkill ? <UnindexedSkillModal cols={cols} skill={currentUnindexedSkill} /> : null}
      {mode === "profiles" ? <ProfilesModal cols={cols} catalog={catalog} names={profileNames} index={profileIndex} /> : null}
      {mode === "diff" && current && diffResult ? <DiffModal cols={cols} row={current} result={diffResult} /> : null}
      {mode === "link" && current && linkFlow ? <LinkModal cols={cols} row={current} flow={linkFlow} recents={catalog.state.recentProjects} /> : null}
      {mode === "index" && currentUnindexedSkill && indexFlow ? <IndexSkillModal cols={cols} skill={currentUnindexedSkill} flow={indexFlow} /> : null}
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
  fileTreeWidth,
  fileTreeMode,
  height,
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
  fileTreeWidth: number;
  fileTreeMode: "split" | "hidden" | "only";
  height: number;
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

  if (!data || !skill) {
    return (
      <box border borderStyle="single" borderColor={colors.modalBorder} flexGrow={1} paddingLeft={2}>
        <text fg={colors.muted}>{"Select a skill to read its documentation."}</text>
      </box>
    );
  }
  const treeRows = fileTreeRows(data.files);
  const treeIndex = Math.max(
    0,
    treeRows.findIndex((row) => row.kind === "file" && row.path === data.file),
  );
  const treeViewport = Math.max(1, height - 4);
  const treeWin = windowOf(0, treeIndex, treeRows.length, treeViewport);
  const extension = extname(data.file).slice(1).toLowerCase();
  const markdown = extension === "md" || extension === "mdx";
  const content = markdown ? markdownBody(data.file, data.content) : data.content;
  return (
    <box
      border
      borderStyle="single"
      borderColor={panel === "content" || panel === "files" ? colors.accent : colors.modalBorder}
      flexGrow={1}
      flexDirection="column"
      title={treeOnly ? ` files · ${skill} ` : fileTreeMode === "hidden" ? ` document · ${data.file} ` : ` document · ${skill} / ${data.file} `}
      titleColor={panel === "content" || panel === "files" ? colors.accent : colors.muted}
      backgroundColor={colors.panelBg}
      onMouseDown={() => onFocusPanel("content")}
    >
      <box flexGrow={1} flexDirection="row">
        {!treeOnly ? (
          <scrollbox
            ref={scrollRef}
            flexGrow={1}
            paddingLeft={1}
            viewportOptions={{ paddingRight: 1 }}
            verticalScrollbarOptions={{
              visible: true,
              trackOptions: { backgroundColor: colors.panelBg, foregroundColor: colors.modalBorder },
            }}
          >
            {markdown ? (
              <markdown
                ref={(node) => {
                  docRef.current = node;
                }}
                width="100%"
                content={content}
                syntaxStyle={syntaxStyle}
                streaming
                internalBlockMode="top-level"
                tableOptions={{ style: "grid", widthMode: "full", wrapMode: "word" }}
                conceal
                fg={colors.text}
                bg={colors.panelBg}
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
        ) : null}
        {fileTreeMode !== "hidden" ? (
          <box
            width={treeOnly ? "100%" : fileTreeWidth}
            flexDirection="column"
            border={treeOnly ? [] : ["left"]}
            borderStyle="single"
            borderColor={panel === "files" ? colors.accent : colors.modalBorder}
            paddingLeft={1}
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
            <TextLine fg={panel === "files" ? colors.accent : colors.muted}>{` FILES  ${data.idx + 1}/${data.files.length}`}</TextLine>
            {treeRows.slice(treeWin, treeWin + treeViewport).map((row) => {
              const selected = row.kind === "file" && row.path === data.file;
              const prefix = row.kind === "folder" ? "▾ " : selected ? "› " : "  ";
              const fileIndex = row.kind === "file" ? data.files.indexOf(row.path) : -1;
              return (
                <TextLine
                  key={`${row.kind}:${row.path}`}
                  fg={row.kind === "folder" ? colors.accent : selected ? colors.selectedText : colors.text}
                  bg={selected ? colors.selectedBg : undefined}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                    onFocusPanel("files");
                    if (fileIndex !== -1) onSelectFile(fileIndex);
                  }}
                >
                  {`${"  ".repeat(row.depth)}${prefix}${row.label}`}
                </TextLine>
              );
            })}
          </box>
        ) : null}
      </box>
    </box>
  );
}

// ---- overlays ------------------------------------------------------------

function HelpModal({ cols }: { cols: number }) {
  const lines: Array<[string, string]> = [
    ["h/l, left/right", "focus the previous or next panel"],
    ["tab", "focus the next panel, wrapping at the end"],
    ["j/k, up/down", "move or scroll within the focused panel"],
    ["0 / $", "focus the first / last panel"],
    ["gg / G", "first / last item or document boundary"],
    ["ctrl-d / ctrl-u", "half-page down / up"],
    ["ctrl-f / ctrl-b", "full page down / up"],
    ["ctrl-e / ctrl-y", "scroll the document one line from any panel"],
    ["x", "expand or restore the focused primary panel"],
    ["v / V", "cycle layouts forward / backward: three, two, focused"],
    ["< / >", "shrink / grow the focused pane in a two-pane layout"],
    ["J / K, PgUp/PgDn", "scroll the document from any panel"],
    ["[ / ]", "previous / next related file"],
    ["{ / }", "previous / next markdown heading in the document"],
    ["n / N", "next / previous document search match"],
    ["enter", "enter the next panel; from document, show details"],
    ["i", "show skill details"],
    ["e", "edit a local or unindexed host skill in nvim"],
    ["1 / 2", "available here / all skills view"],
    ["a", "index selected unindexed .agents skill"],
    ["space", "toggle a skill or every skill by the focused author"],
    ["u", "check vendor skills for upstream updates"],
    ["L", "link skill into a project (copy or symlink)"],
    ["d", "diff live global copy vs repo baseline"],
    ["p", "profile picker (exact-set apply)"],
    ["/", "filter lists; in the document pane, search the document"],
    ["r", "reload catalog"],
    ["drag / ctrl-c", "copy selected text to clipboard"],
    ["q / ctrl-c", "quit (ctrl-c only without a text selection)"],
    ["mouse", "click rows/tabs/panels; drag text to copy; wheel scrolls"],
  ];
  return (
    <Modal title="help" width={76} cols={cols}>
      {lines.map(([keys, label]) => (
        <TextLine key={keys}>
          <span fg={colors.accent}>{fitCell(keys, 18)}</span>
          <span fg={colors.text}>{label}</span>
        </TextLine>
      ))}
      <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
    </Modal>
  );
}

function DetailModal({ cols, row, catalog }: { cols: number; row: CatalogRow; catalog: Catalog }) {
  const desc = skillDescription(catalog.repo, row.meta);
  const links = linksForSkill(catalog.state, row.name);
  const upstream = row.meta.origin === "vendor" ? row.meta.upstream : null;
  const source = upstream?.kind === "github" ? upstream.repository : upstream?.kind === "well-known" ? upstream.source : null;
  const sourceUrl = upstream?.kind === "unknown" ? null : upstream?.url;
  const field = (label: string, value: string, fg: string = colors.text) => (
    <TextLine key={label}>
      <span fg={colors.muted}>{fitCell(label, 12)}</span>
      <span fg={fg}>{value}</span>
    </TextLine>
  );
  return (
    <Modal title={row.name} width={76} cols={cols}>
      {desc ? (
        <box paddingBottom={1}>
          <text fg={colors.text} wrapMode="word">
            {desc}
          </text>
        </box>
      ) : null}
      {field("origin", row.origin)}
      {field("path", row.meta.path)}
      {source ? field("source", source) : null}
      {sourceUrl ? field("url", sourceUrl, colors.accent) : null}
      {field("enabled", row.enabled ? "yes" : "no", row.enabled ? colors.green : colors.muted)}
      {field("live", liveLabel[row.live], liveColor[row.live])}
      {field("claude", row.claude ? "linked" : "not linked")}
      {row.projectLink
        ? field(
            "here",
            `${row.projectSkill ? `${row.projectLink.mode} · ${row.projectLink.excludedTargets.includes(`.agents/skills/${row.name}`) ? "hidden" : "tracked"}` : "missing"} · ${catalog.project}`,
            row.projectSkill ? colors.accent : colors.red,
          )
        : row.projectSkill
          ? field(
              "here",
              `unmanaged (${[row.projectSkill.agents ? ".agents" : "", row.projectSkill.claude ? ".claude" : ""].filter(Boolean).join(" + ")}) · ${catalog.project}`,
              colors.yellow,
            )
          : field("here", "not present", colors.muted)}
      {field("hash", row.meta.contentHash.slice(0, 16) + "\u2026")}
      {row.meta.origin === "vendor" && row.meta.vendoredAt ? field("vendored", formatUtc(row.meta.vendoredAt).slice(0, 10)) : null}
      {links.length > 0 ? (
        <box flexDirection="column" paddingTop={1}>
          <TextLine fg={colors.muted}>{"project links:"}</TextLine>
          {links.map((l) => (
            <TextLine key={l.project}>
              <span fg={colors.text}>{`  ${l.project}`}</span>
              <span fg={colors.muted}>{` (${l.mode})`}</span>
            </TextLine>
          ))}
        </box>
      ) : null}
      <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
    </Modal>
  );
}

function ProjectSkillModal({ cols, skill, catalog }: { cols: number; skill: ProjectSkill; catalog: Catalog }) {
  const desc = projectSkillDescription(catalog.project, skill);
  const stores = [skill.agents ? ".agents" : "", skill.claude ? ".claude" : ""].filter(Boolean).join(" + ");
  const field = (label: string, value: string, fg: string = colors.text) => (
    <TextLine key={label}>
      <span fg={colors.muted}>{fitCell(label, 12)}</span>
      <span fg={fg}>{value}</span>
    </TextLine>
  );
  return (
    <Modal title={`${skill.name} · project only`} width={76} cols={cols}>
      {desc ? (
        <box paddingBottom={1}>
          <text fg={colors.text} wrapMode="word">
            {desc}
          </text>
        </box>
      ) : null}
      {field("project", catalog.project)}
      {field("stores", stores)}
      {field("source", projectSkillPath(catalog.project, skill), colors.accent)}
      {field("catalog", "not managed by Slinky", colors.yellow)}
      <TextLine fg={colors.muted}>{"esc to close · use the document panel to review files"}</TextLine>
    </Modal>
  );
}

function UnindexedSkillModal({ cols, skill }: { cols: number; skill: UnindexedSkill }) {
  const desc = unindexedSkillDescription(skill);
  return (
    <Modal title={`${skill.name} · unindexed`} width={76} cols={cols}>
      {desc ? (
        <box paddingBottom={1}>
          <text fg={colors.text} wrapMode="word">
            {desc}
          </text>
        </box>
      ) : null}
      <TextLine>
        <span fg={colors.muted}>{fitCell("origin", 12)}</span>
        <span fg={colors.text}>{skill.origin}</span>
      </TextLine>
      <TextLine>
        <span fg={colors.muted}>{fitCell("path", 12)}</span>
        <span fg={colors.accent}>{skill.path}</span>
      </TextLine>
      <TextLine fg={colors.yellow}>{"present in the host but absent from skills.manifest.json"}</TextLine>
      <TextLine fg={colors.muted}>{"esc, then a to index with a skills.sh source"}</TextLine>
    </Modal>
  );
}

function IndexSkillModal({ cols, skill, flow }: { cols: number; skill: UnindexedSkill; flow: IndexFlow }) {
  return (
    <Modal title={`index ${skill.name}`} width={86} cols={cols}>
      <TextLine fg={colors.muted}>{"skills.sh source or add command:"}</TextLine>
      <TextLine>
        <span fg={colors.accent}>{" > "}</span>
        <span fg={colors.text}>{flow.input}</span>
        <span fg={colors.accent}>{flow.running ? "" : "\u2588"}</span>
      </TextLine>
      <TextLine fg={colors.muted}>{`example: skills add kitlangton/skills --skill ${skill.name}`}</TextLine>
      <TextLine fg={colors.muted}>{`source: ${skill.path}`}</TextLine>
      {flow.running ? <TextLine fg={colors.yellow}>{"installing, indexing, and syncing..."}</TextLine> : null}
      {flow.error ? <TextLine fg={colors.red}>{` ${flow.error}`}</TextLine> : null}
      <TextLine fg={colors.muted}>{flow.running ? "please wait" : "enter index · esc cancel"}</TextLine>
    </Modal>
  );
}

function ProfilesModal({ cols, catalog, names, index }: { cols: number; catalog: Catalog; names: string[]; index: number }) {
  return (
    <Modal title="profiles" width={56} cols={cols}>
      {names.map((name, i) => {
        const isSel = i === index;
        const active = catalog.state.activeProfile === name;
        const members = getProfile(catalog.manifest, name) ?? [];
        return (
          <TextLine key={name} fg={isSel ? colors.selectedText : colors.text} bg={isSel ? colors.selectedBg : undefined}>
            <span>{` ${fitCell(name, 20)}`}</span>
            <span fg={colors.muted}>{fitCell(`${members.length} skills`, 12)}</span>
            <span fg={colors.green}>{active ? "active" : ""}</span>
          </TextLine>
        );
      })}
      <TextLine fg={colors.yellow}>{"applying a profile disables everything outside it"}</TextLine>
      <TextLine fg={colors.muted}>{"enter apply · esc close"}</TextLine>
    </Modal>
  );
}

function DiffModal({ cols, row, result }: { cols: number; row: CatalogRow; result: DiffResult }) {
  if (result.kind === "local") {
    return (
      <Modal title={`diff ${row.name}`} width={64} cols={cols}>
        <TextLine fg={colors.muted}>{"local skill: lives in the repo, nothing to diff"}</TextLine>
        <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
      </Modal>
    );
  }
  if (result.kind === "not-installed") {
    return (
      <Modal title={`diff ${row.name}`} width={64} cols={cols}>
        <TextLine fg={colors.muted}>{"not installed globally (disabled?)"}</TextLine>
        <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
      </Modal>
    );
  }
  const d: DirDiff = result.diff;
  const cap = 14;
  const entries: Array<{ sign: string; fg: string; file: string }> = [
    ...d.added.map((f) => ({ sign: "+", fg: colors.green, file: f })),
    ...d.removed.map((f) => ({ sign: "-", fg: colors.red, file: f })),
    ...d.modified.map((f) => ({ sign: "~", fg: colors.yellow, file: f })),
  ];
  return (
    <Modal title={`diff ${row.name}`} width={76} cols={cols}>
      {entries.length === 0 ? (
        <TextLine fg={colors.green}>{`in sync (${d.unchanged} files match the repo baseline)`}</TextLine>
      ) : (
        <box flexDirection="column">
          <TextLine fg={colors.yellow}>{"live global copy differs from repo baseline:"}</TextLine>
          {entries.slice(0, cap).map((e) => (
            <TextLine key={`${e.sign}${e.file}`}>
              <span fg={e.fg}>{` ${e.sign} ${e.file}`}</span>
            </TextLine>
          ))}
          {entries.length > cap ? <TextLine fg={colors.muted}>{`  \u2026 ${entries.length - cap} more`}</TextLine> : null}
          <TextLine>
            <span fg={colors.accent}>{"a"}</span>
            <span fg={colors.muted}>{" accept global  "}</span>
            <span fg={colors.accent}>{"r"}</span>
            <span fg={colors.muted}>{" restore baseline  "}</span>
            <span fg={colors.accent}>{"h"}</span>
            <span fg={colors.muted}>{" hunk  "}</span>
            <span fg={colors.accent}>{"d"}</span>
            <span fg={colors.muted}>{" delta"}</span>
          </TextLine>
        </box>
      )}
      <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
    </Modal>
  );
}

function LinkModal({ cols, row, flow, recents }: { cols: number; row: CatalogRow; flow: LinkFlow; recents: ReadonlyArray<string> }) {
  return (
    <Modal title={`link ${row.name}`} width={76} cols={cols}>
      {flow.step === "project" ? (
        <box flexDirection="column">
          <TextLine fg={colors.muted}>{"project directory:"}</TextLine>
          <TextLine>
            <span fg={colors.accent}>{" > "}</span>
            <span fg={colors.text}>{flow.input}</span>
            <span fg={colors.accent}>{"\u2588"}</span>
          </TextLine>
          {flow.error ? <TextLine fg={colors.red}>{` ${flow.error}`}</TextLine> : null}
          {recents.length > 0 ? (
            <box flexDirection="column" paddingTop={1}>
              <TextLine fg={colors.muted}>{"recent (up/down):"}</TextLine>
              {recents.slice(0, 5).map((p, i) => (
                <TextLine key={p} fg={i === flow.recentIndex ? colors.selectedText : colors.muted} bg={i === flow.recentIndex ? colors.selectedBg : undefined}>
                  {`  ${p}`}
                </TextLine>
              ))}
            </box>
          ) : null}
          <TextLine fg={colors.muted}>{"enter continue · esc cancel"}</TextLine>
        </box>
      ) : null}
      {flow.step === "mode" ? (
        <box flexDirection="column">
          <TextLine fg={colors.muted}>{`into ${flow.input}`}</TextLine>
          <TextLine fg={flow.mode === "copy" ? colors.selectedText : colors.muted} bg={flow.mode === "copy" ? colors.selectedBg : undefined}>
            {" copy     snapshot; project owns its copy (drift is tracked)"}
          </TextLine>
          <TextLine fg={flow.mode === "symlink" ? colors.selectedText : colors.muted} bg={flow.mode === "symlink" ? colors.selectedBg : undefined}>
            {" symlink  live; project always sees the repo version"}
          </TextLine>
          <TextLine fg={colors.muted}>{"j/k or c/s choose · enter continue · esc cancel"}</TextLine>
        </box>
      ) : null}
      {flow.step === "options" ? (
        <box flexDirection="column">
          <TextLine fg={colors.muted}>{`${flow.mode} into ${flow.input}`}</TextLine>
          <TextLine>
            <span fg={colors.accent}>{" e "}</span>
            <span fg={colors.text}>{`[${flow.exclude ? "x" : " "}] add to .git/info/exclude`}</span>
          </TextLine>
          <TextLine>
            <span fg={colors.accent}>{" c "}</span>
            <span fg={colors.text}>{`[${flow.claude ? "x" : " "}] .claude/skills symlink (when .claude exists)`}</span>
          </TextLine>
          <TextLine fg={colors.muted}>{"enter link it · esc cancel"}</TextLine>
        </box>
      ) : null}
    </Modal>
  );
}
