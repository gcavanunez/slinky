import { useEffect, useMemo, useRef, useState } from "react";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import type { DirDiff } from "../lib/diff.ts";
import { formatUtc, getProfile } from "../lib/manifest.ts";
import { REPO } from "../lib/paths.ts";
import { Hint, Modal, TextLine } from "./components.tsx";
import { colors } from "./theme.ts";
import { clamp, fitCell, printable, windowOf } from "./util.ts";
import {
  applyProfile,
  diffSkill,
  doLink,
  expandHome,
  linksForSkill,
  loadCatalog,
  projectSkillDescription,
  projectSkillFiles,
  projectSkillPath,
  readProjectSkillFile,
  readSkillFile,
  setEnabled,
  setSkillsEnabled,
  skillDescription,
  skillFiles,
  verifyRow,
} from "./data.ts";
import type {
  ActionResult,
  Catalog,
  CatalogRow,
  DiffResult,
  LiveStatus,
  ProjectSkill,
} from "./data.ts";

type Mode = "list" | "help" | "detail" | "profiles" | "diff" | "link";

type ListItem =
  | {
      kind: "header";
      label: string;
      count: number;
      enabledCount: number | null;
      rows: ReadonlyArray<CatalogRow> | null;
      collapsed: boolean;
    }
  | { kind: "skill"; row: CatalogRow }
  | { kind: "project-skill"; skill: ProjectSkill };

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

const liveColor: Record<LiveStatus, string> = {
  ok: colors.green,
  drift: colors.yellow,
  missing: colors.red,
  off: colors.muted,
  stale: colors.yellow,
  checking: colors.muted,
};

const liveLabel: Record<LiveStatus, string> = {
  ok: "ok",
  drift: "drift",
  missing: "missing",
  off: "-",
  stale: "stale",
  checking: "\u2026",
};

export function App() {
  const renderer = useRenderer();
  const { width: cols, height: rowsAvail } = useTerminalDimensions();

  const [catalog, setCatalog] = useState<Catalog>(() => loadCatalog());
  const [nonce, setNonce] = useState(0);
  // index 0 is always the first group header; start on the first skill
  const [selected, setSelected] = useState(1);
  const [offset, setOffset] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [filterMode, setFilterMode] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null);
  const [profileIndex, setProfileIndex] = useState(0);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [linkFlow, setLinkFlow] = useState<LinkFlow | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState(false);
  const [previewFile, setPreviewFile] = useState(0);
  const [previewScroll, setPreviewScroll] = useState(0);

  const quitting = useRef(false);
  const pendingG = useRef(0);
  const rowsRef = useRef(catalog.rows);
  rowsRef.current = catalog.rows;

  const filtered = useMemo(
    () =>
      filterText
        ? catalog.rows.filter((r) => r.name.includes(filterText.toLowerCase()))
        : catalog.rows,
    [catalog.rows, filterText],
  );

  // Tree view: group skills under their origin owner (local first, then vendors).
  // Filtering ignores folds so matches are never hidden.
  const items = useMemo<ListItem[]>(() => {
    const out: ListItem[] = [];
    const projectOnly = catalog.projectSkills
      .filter(
        (skill) =>
          !Object.hasOwn(catalog.manifest.skills, skill.name) &&
          (!filterText || skill.name.includes(filterText.toLowerCase())),
      )
      .sort((a, b) => Number(b.agents) - Number(a.agents) || a.name.localeCompare(b.name));
    if (projectOnly.length > 0) {
      const label = "project only";
      const isCollapsed = collapsed.has(label) && !filterText;
      out.push({
        kind: "header",
        label,
        count: projectOnly.length,
        enabledCount: null,
        rows: null,
        collapsed: isCollapsed,
      });
      if (!isCollapsed) {
        for (const skill of projectOnly) out.push({ kind: "project-skill", skill });
      }
    }

    const groups = new Map<string, CatalogRow[]>();
    for (const row of filtered) {
      const key = ownerOf(row);
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
    const keys = [...groups.keys()].sort((a, b) =>
      a === "local" ? -1 : b === "local" ? 1 : a < b ? -1 : 1,
    );
    for (const key of keys) {
      const rows = groups.get(key) ?? [];
      const isCollapsed = collapsed.has(key) && !filterText;
      out.push({
        kind: "header",
        label: key,
        count: rows.length,
        enabledCount: rows.filter((r) => r.enabled).length,
        rows,
        collapsed: isCollapsed,
      });
      if (!isCollapsed) for (const row of rows) out.push({ kind: "skill", row });
    }
    return out;
  }, [catalog.manifest.skills, catalog.projectSkills, filtered, collapsed, filterText]);

  const viewport = Math.max(3, rowsAvail - 4 - (filterMode || filterText ? 1 : 0));
  const selItem = clamp(selected, 0, Math.max(0, items.length - 1));
  const win = windowOf(offset, selItem, items.length, viewport);
  const currentItem = items[selItem];
  const current: CatalogRow | undefined =
    currentItem?.kind === "skill" ? currentItem.row : undefined;
  const currentProjectSkill: ProjectSkill | undefined =
    currentItem?.kind === "project-skill" ? currentItem.skill : undefined;
  const currentHeader = currentItem?.kind === "header" ? currentItem : undefined;
  const profileNames = Object.keys(catalog.manifest.profiles);

  useEffect(() => setOffset(win), [win]);

  // Reset preview file/scroll when the selected skill changes.
  const currentName = current?.name ?? currentProjectSkill?.name;
  useEffect(() => {
    setPreviewFile(0);
    setPreviewScroll(0);
  }, [currentName]);

  const previewData = useMemo(() => {
    if (!preview || (!current && !currentProjectSkill)) return null;
    const files = current
      ? skillFiles(current.meta)
      : projectSkillFiles(catalog.project, currentProjectSkill!);
    if (files.length === 0) return null;
    const idx = clamp(previewFile, 0, files.length - 1);
    const file = files[idx] ?? "SKILL.md";
    const lines = current
      ? readSkillFile(current.meta, file)
      : readProjectSkillFile(catalog.project, currentProjectSkill!, file);
    return { files, idx, file, lines };
  }, [preview, current, currentProjectSkill, catalog.project, previewFile]);

  // Incrementally hash-verify vendor rows after (re)load.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const idx = rowsRef.current.findIndex((r) => r.live === "checking");
      if (idx < 0) return;
      const row = rowsRef.current[idx];
      if (!row) return;
      const verified = verifyRow(row);
      setCatalog((prev) => ({
        ...prev,
        rows: prev.rows.map((r) => (r.name === verified.name ? verified : r)),
      }));
      setTimeout(tick, 0);
    };
    const t = setTimeout(tick, 10);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [nonce]);

  const refresh = () => {
    setCatalog(loadCatalog());
    setNonce((n) => n + 1);
  };

  const notify = (text: string, error = false) => {
    setFlash({ text, error });
    const snapshot = text;
    setTimeout(() => {
      setFlash((cur) => (cur?.text === snapshot ? null : cur));
    }, 3000);
  };

  const reportAction = (label: string, res: ActionResult) => {
    if (res.warnings.length > 0) notify(`${label}: ${res.warnings[0]}`, true);
    else notify(`${label} (${res.messages.length} change${res.messages.length === 1 ? "" : "s"})`);
  };

  const quit = () => {
    if (quitting.current) return;
    quitting.current = true;
    renderer.destroy();
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
      setSelected(1); // index 0 is the first group header; land on its first skill
    }
    return true;
  };

  const handleOverlay = (key: KeyEvent): boolean => {
    if (mode === "list") return false;
    if (mode === "link" && linkFlow) return handleLink(key);
    if (key.name === "escape" || key.name === "q") {
      setMode("list");
      return true;
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
          reportAction(`profile ${name}`, applyProfile(name));
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

  const patchFlow = (fn: (prev: LinkFlow) => LinkFlow) =>
    setLinkFlow((prev) => (prev ? fn(prev) : prev));

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
      const res = doLink({
        skill: current.name,
        project: linkFlow.input,
        mode: linkFlow.mode,
        gitExclude: linkFlow.exclude,
        claude: linkFlow.claude,
      });
      if (res.error) notify(res.error, true);
      else notify(`linked ${current.name} (${linkFlow.mode}) into ${linkFlow.input}`);
      setLinkFlow(null);
      setMode("list");
      refresh();
      return true;
    }
    return true;
  };

  const handleList = (key: KeyEvent): void => {
    const move = (delta: number) =>
      setSelected((i) => clamp(i + delta, 0, Math.max(0, items.length - 1)));
    if (key.name === "q" || (key.ctrl && key.name === "c")) return quit();

    // preview panel
    if (key.name === "tab" || key.name === "v") {
      setPreview((p) => !p);
      return;
    }
    if (preview && previewData) {
      const maxScroll = Math.max(0, previewData.lines.length - (viewport - 3));
      if (key.name === "j" && key.shift) return setPreviewScroll((s) => clamp(s + 3, 0, maxScroll));
      if (key.name === "k" && key.shift) return setPreviewScroll((s) => clamp(s - 3, 0, maxScroll));
      if (key.name === "]") {
        setPreviewScroll(0);
        return setPreviewFile((i) => clamp(i + 1, 0, previewData.files.length - 1));
      }
      if (key.name === "[") {
        setPreviewScroll(0);
        return setPreviewFile((i) => clamp(i - 1, 0, previewData.files.length - 1));
      }
    }

    if ((key.name === "j" && !key.shift) || key.name === "down") return move(1);
    if ((key.name === "k" && !key.shift) || key.name === "up") return move(-1);
    if (key.ctrl && key.name === "d") return move(Math.floor(viewport / 2));
    if (key.ctrl && key.name === "u") return move(-Math.floor(viewport / 2));
    if (key.name === "g" && !key.shift) {
      const now = Date.now();
      if (now - pendingG.current < 500) {
        setSelected(0);
        pendingG.current = 0;
      } else {
        pendingG.current = now;
      }
      return;
    }
    if (key.name === "g" && key.shift) return setSelected(Math.max(0, items.length - 1));
    if (key.name === "/") {
      setFilterMode(true);
      setFilterText("");
      return;
    }
    if (key.name === "escape" && filterText) {
      setFilterText("");
      return;
    }
    if (key.name === "r") {
      refresh();
      notify("refreshed");
      return;
    }
    if (key.name === "?") return setMode("help");
    if (key.name === "u") {
      notify("checking upstream\u2026");
      void (async () => {
        try {
          const { checkUpstream } = await import("../lib/update.ts");
          const statuses = await checkUpstream(loadCatalog().manifest);
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
          notify(
            updates + gone === 0
              ? "upstream: everything current"
              : `upstream: ${updates} update(s), ${gone} gone \u2014 run slinky update`,
          );
        } catch (err) {
          notify(`upstream check failed: ${err instanceof Error ? err.message : err}`, true);
        }
      })();
      return;
    }
    if (key.name === "p") {
      if (profileNames.length === 0) return notify("no profiles defined in skills.manifest.json", true);
      setProfileIndex(Math.max(0, profileNames.indexOf(catalog.state.activeProfile ?? "")));
      return setMode("profiles");
    }

    // fold handling
    const toggleFold = (label: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return next;
      });
    if (currentItem?.kind === "header") {
      if (key.name === "space" && currentItem.rows) {
        const enable = !currentItem.rows.some((row) => row.enabled);
        const result = setSkillsEnabled(currentItem.rows.map((row) => row.name), enable);
        reportAction(`${enable ? "enabled" : "disabled"} ${currentItem.label}`, result);
        refresh();
        return;
      }
      if (["return", "enter", "h", "left", "right"].includes(key.name)) {
        return toggleFold(currentItem.label);
      }
      return;
    }
    const currentGroup = current
      ? ownerOf(current)
      : currentProjectSkill ? "project only" : undefined;
    if ((key.name === "h" || key.name === "left") && currentGroup && !filterText) {
      // fold the group under the cursor; selection lands on its header
      const headerIndex = items.findIndex(
        (item) => item.kind === "header" && item.label === currentGroup,
      );
      if (headerIndex >= 0) setSelected(headerIndex);
      return toggleFold(currentGroup);
    }

    if (currentProjectSkill) {
      if (key.name === "return" || key.name === "enter") return setMode("detail");
      return;
    }
    if (!current) return;
    if (key.name === "space") {
      const res = setEnabled(current.name, !current.enabled);
      reportAction(`${current.enabled ? "disabled" : "enabled"} ${current.name}`, res);
      refresh();
      return;
    }
    if (key.name === "return" || key.name === "enter") return setMode("detail");
    if (key.name === "d") {
      setDiffResult(diffSkill(current));
      return setMode("diff");
    }
    if (key.name === "l") {
      // prefer the directory Slinky was launched from (unless it's the skills repo)
      const cwd = process.cwd();
      const defaultProject = cwd !== REPO ? cwd : (catalog.state.recentProjects[0] ?? "");
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
    if (key.eventType === "release" || key.repeated === true && key.name === "g") return;
    if (handleFilter(key)) return;
    if (handleOverlay(key)) return;
    handleList(key);
  });

  // ---- render ------------------------------------------------------------

  const hereW = 6;
  const nameW = Math.max(20, Math.min(34, ...[30]), ...catalog.rows.map((r) => r.name.length)) + 2;
  const listW = preview ? hereW + nameW + 25 : cols;
  const enabledCount = catalog.rows.filter((r) => r.enabled).length;
  const hereCount = catalog.projectSkills.length;
  const projectName = basename(catalog.project) || catalog.project;

  const header = (
    <TextLine fg={colors.text} bg={colors.headerBg}>
      <span fg={colors.accent}>{" slinky "}</span>
      <span fg={colors.muted}>
        {`${enabledCount}/${catalog.rows.length} enabled · profile: ${catalog.state.activeProfile ?? "-"} · project: ${projectName} · ${hereCount} here`}
      </span>
    </TextLine>
  );

  const columns = (
    <TextLine fg={colors.muted}>
      {`${fitCell("HERE", hereW)}${fitCell("NAME", nameW)}${fitCell("ON", 5)}${fitCell("LIVE", 9)}${fitCell("UP", 4)}CLAUDE`}
    </TextLine>
  );

  const upstreamCell = (row: CatalogRow): { label: string; fg: string } => {
    switch (row.upstream) {
      case "update":
        return { label: "^", fg: colors.yellow };
      case "gone":
        return { label: "\u00d7", fg: colors.red };
      case "current":
        return { label: "=", fg: colors.muted };
      default:
        return { label: "", fg: colors.muted };
    }
  };

  const listRows = items.slice(win, win + viewport).map((item, i) => {
    const itemIndex = win + i;
    if (item.kind === "header") {
      const isSel = itemIndex === selItem;
      const arrow = item.collapsed ? "\u25b8" : "\u25be";
      return (
        <TextLine key={`h:${item.label}`} bg={isSel ? colors.selectedBg : undefined}>
          <span fg={colors.accent}>{` ${arrow} ${item.label} `}</span>
          <span fg={colors.muted}>
            {item.enabledCount === null ? `(${item.count})` : `(${item.enabledCount}/${item.count})`}
          </span>
        </TextLine>
      );
    }
    if (item.kind === "project-skill") {
      const isSel = itemIndex === selItem;
      return (
        <TextLine
          key={`p:${item.skill.name}`}
          fg={isSel ? colors.selectedText : colors.yellow}
          bg={isSel ? colors.selectedBg : undefined}
        >
          <span fg={colors.yellow}>{fitCell("local", hereW)}</span>
          <span fg={isSel ? colors.selectedText : colors.yellow}>
            {fitCell(item.skill.name, nameW)}
          </span>
          <span fg={colors.muted}>{fitCell("-", 5)}</span>
          <span fg={colors.yellow}>{fitCell("project", 9)}</span>
          <span fg={colors.muted}>{fitCell("", 4)}</span>
          <span fg={item.skill.claude ? colors.text : colors.muted}>
            {fitCell(item.skill.claude ? "yes" : "-", Math.max(1, listW - nameW - hereW - 19))}
          </span>
        </TextLine>
      );
    }
    const row = item.row;
    const isSel = itemIndex === selItem;
    const fg = isSel ? colors.selectedText : colors.text;
    const bg = isSel ? colors.selectedBg : undefined;
    const here = row.projectLink
      ? row.projectSkill
        ? row.projectLink.mode === "symlink" ? "link" : "copy"
        : "miss"
      : row.projectSkill ? "local" : "";
    const hereColor = here === "miss" ? colors.red : here === "local" ? colors.yellow : colors.accent;
    return (
      <TextLine key={row.name} fg={fg} bg={bg}>
        <span fg={here ? hereColor : colors.muted}>{fitCell(here, hereW)}</span>
        <span fg={isSel ? colors.selectedText : here ? hereColor : colors.text}>
          {fitCell(row.name, nameW)}
        </span>
        <span fg={row.enabled ? colors.green : colors.muted}>{fitCell(row.enabled ? "on" : "off", 5)}</span>
        <span fg={liveColor[row.live]}>{fitCell(liveLabel[row.live], 9)}</span>
        <span fg={upstreamCell(row).fg}>{fitCell(upstreamCell(row).label, 4)}</span>
        <span fg={row.claude ? colors.text : colors.muted}>
          {fitCell(row.claude ? "yes" : "-", Math.max(1, listW - nameW - hereW - 19))}
        </span>
      </TextLine>
    );
  });

  const matchCount = items.filter((item) => item.kind !== "header").length;
  const filterBar =
    filterMode || filterText ? (
      <TextLine fg={colors.text}>
        <span fg={colors.accent}>{" /"}</span>
        <span>{filterText}</span>
        <span fg={colors.accent}>{filterMode ? "\u2588" : ""}</span>
        <span fg={colors.muted}>{`  (${matchCount} match${matchCount === 1 ? "" : "es"})`}</span>
      </TextLine>
    ) : null;

  const footer = flash ? (
    <TextLine fg={flash.error ? colors.red : colors.green}>{` ${flash.text}`}</TextLine>
  ) : preview ? (
    <TextLine>
      <span>{" "}</span>
      <Hint keys="j/k" label="move" />
      <Hint keys="J/K" label="scroll" />
      <Hint keys="[/]" label="file" />
      <Hint keys="tab" label="close preview" />
      {current ? <Hint keys="space" label="toggle" /> : null}
      <Hint keys="enter" label="detail" />
      <Hint keys="?" label="help" />
      <Hint keys="q" label="quit" />
    </TextLine>
  ) : currentProjectSkill ? (
    <TextLine>
      <span>{" "}</span>
      <Hint keys="j/k" label="move" />
      <Hint keys="h" label="fold" />
      <Hint keys="tab" label="preview" />
      <Hint keys="enter" label="detail" />
      <Hint keys="/" label="filter" />
      <Hint keys="?" label="help" />
      <Hint keys="q" label="quit" />
    </TextLine>
  ) : currentHeader ? (
    <TextLine>
      <span>{" "}</span>
      <Hint keys="j/k" label="move" />
      <Hint keys="h/enter" label="fold" />
      {currentHeader.rows ? <Hint keys="space" label="toggle author" /> : null}
      <Hint keys="p" label="profiles" />
      <Hint keys="/" label="filter" />
      <Hint keys="?" label="help" />
      <Hint keys="q" label="quit" />
    </TextLine>
  ) : (
    <TextLine>
      <span>{" "}</span>
      <Hint keys="j/k" label="move" />
      <Hint keys="h" label="fold" />
      <Hint keys="tab" label="preview" />
      <Hint keys="space" label="toggle" />
      <Hint keys="enter" label="detail" />
      <Hint keys="l" label="link" />
      <Hint keys="d" label="diff" />
      <Hint keys="p" label="profiles" />
      <Hint keys="/" label="filter" />
      <Hint keys="?" label="help" />
      <Hint keys="q" label="quit" />
    </TextLine>
  );

  return (
    <box width="100%" height="100%" flexDirection="column">
      {header}
      {filterBar}
      {columns}
      <box flexGrow={1} flexDirection="row">
        <box flexDirection="column" width={preview ? listW : "100%"}>
          {listRows}
          {matchCount === 0 ? <TextLine fg={colors.muted}>{"  no skills match"}</TextLine> : null}
        </box>
        {preview ? (
          <PreviewPanel data={previewData} skill={currentName} scroll={previewScroll} height={viewport} />
        ) : null}
      </box>
      {footer}
      {mode === "help" ? <HelpModal cols={cols} /> : null}
      {mode === "detail" && current ? <DetailModal cols={cols} row={current} catalog={catalog} /> : null}
      {mode === "detail" && currentProjectSkill ? (
        <ProjectSkillModal cols={cols} skill={currentProjectSkill} catalog={catalog} />
      ) : null}
      {mode === "profiles" ? (
        <ProfilesModal cols={cols} catalog={catalog} names={profileNames} index={profileIndex} />
      ) : null}
      {mode === "diff" && current && diffResult ? (
        <DiffModal cols={cols} row={current} result={diffResult} />
      ) : null}
      {mode === "link" && current && linkFlow ? (
        <LinkModal cols={cols} row={current} flow={linkFlow} recents={catalog.state.recentProjects} />
      ) : null}
    </box>
  );
}

// ---- preview ---------------------------------------------------------------

function PreviewPanel({
  data,
  skill,
  scroll,
  height,
}: {
  data: { files: string[]; idx: number; file: string; lines: string[] } | null;
  skill: string | undefined;
  scroll: number;
  height: number;
}) {
  const inner = Math.max(1, height - 2);
  if (!data || !skill) {
    return (
      <box border borderStyle="single" borderColor={colors.modalBorder} flexGrow={1} paddingLeft={1}>
        <text fg={colors.muted}>{"select a skill to preview"}</text>
      </box>
    );
  }
  const total = data.lines.length;
  const end = Math.min(total, scroll + inner);
  const pos = total > inner ? ` ${scroll + 1}-${end}/${total}` : "";
  return (
    <box
      border
      borderStyle="single"
      borderColor={colors.modalBorder}
      flexGrow={1}
      flexDirection="column"
      paddingLeft={1}
      title={` ${skill}: ${data.file} (${data.idx + 1}/${data.files.length})${pos} `}
    >
      {data.lines.slice(scroll, scroll + inner).map((line, i) => (
        <TextLine key={scroll + i} fg={colors.text}>{line.length > 0 ? line : " "}</TextLine>
      ))}
    </box>
  );
}

// ---- overlays ------------------------------------------------------------

function HelpModal({ cols }: { cols: number }) {
  const lines: Array<[string, string]> = [
    ["j/k, arrows", "move selection"],
    ["gg / G", "first / last"],
    ["ctrl-d / ctrl-u", "half-page down / up"],
    ["h / left", "fold group (on a header: toggle fold)"],
    ["tab / v", "toggle preview panel (SKILL.md + related files)"],
    ["J / K", "scroll preview"],
    ["[ / ]", "previous / next file in preview"],
    ["space", "toggle skill; on an author header, toggle the entire group"],
    ["u", "check upstream for updates (UP column: ^ update, \u00d7 gone)"],
    ["enter", "skill detail"],
    ["l", "link skill into a project (copy or symlink)"],
    ["d", "diff live global copy vs repo baseline"],
    ["p", "profile picker (exact-set apply)"],
    ["/", "filter by name (esc clears)"],
    ["r", "reload catalog"],
    ["q / ctrl-c", "quit"],
  ];
  return (
    <Modal title="help" width={64} cols={cols}>
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
  const desc = skillDescription(row.meta);
  const links = linksForSkill(catalog.state, row.name);
  const upstream = row.meta.origin === "vendor" ? row.meta.upstream : null;
  const source =
    upstream?.kind === "github"
      ? upstream.repository
      : upstream?.kind === "well-known"
        ? upstream.source
        : null;
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
          <text fg={colors.text} wrapMode="word">{desc}</text>
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
            `${row.projectSkill ? row.projectLink.mode : "missing"} · ${catalog.project}`,
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
      {row.meta.origin === "vendor" && row.meta.vendoredAt
        ? field("vendored", formatUtc(row.meta.vendoredAt).slice(0, 10))
        : null}
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

function ProjectSkillModal({
  cols,
  skill,
  catalog,
}: {
  cols: number;
  skill: ProjectSkill;
  catalog: Catalog;
}) {
  const desc = projectSkillDescription(catalog.project, skill);
  const stores = [skill.agents ? ".agents" : "", skill.claude ? ".claude" : ""]
    .filter(Boolean)
    .join(" + ");
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
          <text fg={colors.text} wrapMode="word">{desc}</text>
        </box>
      ) : null}
      {field("project", catalog.project)}
      {field("stores", stores)}
      {field("source", projectSkillPath(catalog.project, skill), colors.accent)}
      {field("catalog", "not managed by Slinky", colors.yellow)}
      <TextLine fg={colors.muted}>{"esc to close · tab from the list to preview files"}</TextLine>
    </Modal>
  );
}

function ProfilesModal({
  cols,
  catalog,
  names,
  index,
}: {
  cols: number;
  catalog: Catalog;
  names: string[];
  index: number;
}) {
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
          {entries.length > cap ? (
            <TextLine fg={colors.muted}>{`  \u2026 ${entries.length - cap} more`}</TextLine>
          ) : null}
          <TextLine fg={colors.muted}>{`full patch: slinky diff ${row.name} --patch`}</TextLine>
          <TextLine fg={colors.muted}>{`accept: slinky vendor ${row.name} · reject: slinky restore ${row.name}`}</TextLine>
        </box>
      )}
      <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
    </Modal>
  );
}

function LinkModal({
  cols,
  row,
  flow,
  recents,
}: {
  cols: number;
  row: CatalogRow;
  flow: LinkFlow;
  recents: ReadonlyArray<string>;
}) {
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
                <TextLine
                  key={p}
                  fg={i === flow.recentIndex ? colors.selectedText : colors.muted}
                  bg={i === flow.recentIndex ? colors.selectedBg : undefined}
                >
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
          <TextLine
            fg={flow.mode === "copy" ? colors.selectedText : colors.muted}
            bg={flow.mode === "copy" ? colors.selectedBg : undefined}
          >
            {" copy     snapshot; project owns its copy (drift is tracked)"}
          </TextLine>
          <TextLine
            fg={flow.mode === "symlink" ? colors.selectedText : colors.muted}
            bg={flow.mode === "symlink" ? colors.selectedBg : undefined}
          >
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
