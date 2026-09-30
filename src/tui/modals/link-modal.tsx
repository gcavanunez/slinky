/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import type { LinkFlow } from "../app.tsx";
import { Modal, TextLine, modalInner } from "../components.tsx";
import { tildePath } from "../data.ts";
import type { CatalogRow } from "../data.ts";
import { colors } from "../theme.ts";
import { fitCell, wrapText } from "../util.ts";

const WIDTH = 76;

/** Where the skill can go, resolved once when the form opens. */
export interface LinkTargets {
  /** The git work tree around the working directory, when it can take a link. */
  readonly project: string | null;
  /** Why there is no project target, shown in its place. */
  readonly projectBlocked: string | null;
  readonly globalStore: string;
  readonly globalOn: boolean;
}

/** One focusable control in the link form, in tab order. */
export type LinkStop =
  | { readonly kind: "target"; readonly target: LinkFlow["target"] }
  | { readonly kind: "mode"; readonly mode: LinkFlow["mode"] }
  | { readonly kind: "option"; readonly option: "exclude" | "claude" };

export const linkStops: ReadonlyArray<LinkStop> = [
  { kind: "target", target: "project" },
  { kind: "target", target: "global" },
  { kind: "mode", mode: "copy" },
  { kind: "mode", mode: "symlink" },
  { kind: "option", option: "exclude" },
  { kind: "option", option: "claude" },
];

/** Unavailable targets, and the project-only controls while global is chosen, are skipped. */
export function linkStopEnabled(stop: LinkStop, flow: LinkFlow, targets: LinkTargets): boolean {
  if (stop.kind === "target") return stop.target === "project" ? targets.project !== null : !targets.globalOn;
  return flow.target === "project";
}

/** Truncate from the left so a long path keeps its project directory visible. */
function keepTail(text: string, width: number): string {
  return text.length > width && width > 1 ? `…${text.slice(text.length - width + 1)}` : text;
}

function spaceLabel(stop: LinkStop | undefined): string {
  if (stop?.kind === "option") return "toggle";
  return "choose";
}

export function LinkModal({
  cols,
  rows,
  row,
  flow,
  targets,
  onClick,
}: {
  cols: number;
  rows: number;
  row: CatalogRow;
  flow: LinkFlow;
  targets: LinkTargets;
  onClick: (stop: number) => void;
}) {
  const { contentWidth } = modalInner(WIDTH, cols);
  const focused = linkStops[flow.focus];
  const projectOnly = flow.target === "global";

  const heading = (label: string, hint: string, active: boolean) => (
    <TextLine key={`heading-${label}`}>
      <span fg={active ? colors.count : colors.muted}>{label}</span>
      <span fg={colors.muted}>{`  ${hint}`}</span>
    </TextLine>
  );
  // A choice row: mark, label column, detail; focused rows are highlighted, unavailable ones dimmed.
  const choice = (index: number, mark: string, on: boolean, label: string, detail: string) => {
    const stop = linkStops[index];
    const enabled = stop !== undefined && linkStopEnabled(stop, flow, targets);
    const isFocused = index === flow.focus;
    const fg = !enabled ? colors.separator : isFocused ? colors.selectedText : colors.text;
    const detailFg = !enabled ? colors.separator : isFocused ? colors.selectedText : colors.muted;
    const markFg = !enabled ? colors.separator : on ? colors.green : detailFg;
    return (
      <TextLine key={`stop-${index}`} fg={fg} bg={isFocused ? colors.selectedBg : undefined} onMouseDown={() => onClick(index)}>
        <span fg={markFg}>{`${mark} `}</span>
        <span>{fitCell(label, 16)}</span>
        <span fg={detailFg}>{fitCell(detail, Math.max(8, contentWidth - 20))}</span>
      </TextLine>
    );
  };

  const lines: ReactNode[] = [];
  lines.push(heading("target", "where the skill goes", focused?.kind === "target"));
  linkStops.forEach((stop, index) => {
    if (stop.kind !== "target") return;
    const on = flow.target === stop.target;
    const detail =
      stop.target === "project"
        ? targets.project === null
          ? (targets.projectBlocked ?? "")
          : keepTail(tildePath(targets.project), contentWidth - 20)
        : targets.globalOn
          ? "already on, turn it off with space in the catalog"
          : `${targets.globalStore}, every project sees it`;
    lines.push(choice(index, on ? "(*)" : "( )", on, stop.target === "project" ? "this project" : "global", detail));
  });

  lines.push(<box key="gap-mode" height={1} />);
  lines.push(heading("mode", projectOnly ? "project only" : "how the project gets the skill", focused?.kind === "mode"));
  linkStops.forEach((stop, index) => {
    if (stop.kind !== "mode") return;
    const on = flow.mode === stop.mode;
    const detail = stop.mode === "copy" ? "a snapshot the project owns, drift is tracked" : "stays live with the library version";
    lines.push(choice(index, on ? "(*)" : "( )", on, stop.mode, detail));
  });

  lines.push(<box key="gap-options" height={1} />);
  lines.push(heading("options", projectOnly ? "project only" : "", focused?.kind === "option"));
  linkStops.forEach((stop, index) => {
    if (stop.kind !== "option") return;
    const on = stop.option === "exclude" ? flow.exclude : flow.claude;
    const [label, detail] = stop.option === "exclude" ? ["hide from git", "adds it to .git/info/exclude"] : [".claude/skills", "symlink it there too when .claude/ exists"];
    lines.push(choice(index, on ? "[x]" : "[ ]", on, label, detail));
  });

  if (flow.error) {
    lines.push(<box key="gap-error" height={1} />);
    for (const [index, line] of wrapText(flow.error, contentWidth).entries()) {
      lines.push(
        <TextLine key={`error-${index}`} fg={colors.error}>
          {line}
        </TextLine>,
      );
    }
  }

  return (
    <Modal
      title={`Link ${row.name}`}
      subtitle={<TextLine fg={colors.muted}>{"into this project, or turn it on globally"}</TextLine>}
      width={WIDTH}
      cols={cols}
      rows={rows}
      bodyRows={lines.length}
      footer={[
        { key: "tab/↑↓", label: "move" },
        { key: "space", label: spaceLabel(focused) },
        { key: "enter", label: projectOnly ? "turn on" : "link" },
        { key: "esc", label: "cancel" },
      ]}
    >
      {lines}
    </Modal>
  );
}
