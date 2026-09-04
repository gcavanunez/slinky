/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import type { ConvergenceEvent } from "../../lib/convergence.ts";
import { Modal, TextLine, modalInner } from "../components.tsx";
import { colors } from "../theme.ts";
import { fitCell } from "../util.ts";

export interface SyncFlow {
  readonly events: ReadonlyArray<ConvergenceEvent>;
  readonly running: boolean;
  readonly error?: string;
  /** First visible line; null follows the tail as output arrives. */
  readonly scroll: number | null;
}

const WIDTH = 86;

/** Body rows the log gets at this terminal height; App uses it to clamp scrolling. */
export function syncLogRows(rows: number): number {
  return Math.max(3, rows - 9);
}

export function syncLogLength(flow: SyncFlow): number {
  return flow.events.reduce((sum, event) => sum + eventLines(event).length, 0) + (flow.error ? 1 : 0);
}

function eventLines(event: ConvergenceEvent): Array<{ text: string; fg: string; bold?: boolean }> {
  switch (event.type) {
    case "section":
      return [...(event.leadingBlank ? [{ text: "", fg: colors.text }] : []), { text: event.title.toUpperCase(), fg: colors.count, bold: true }];
    case "git-output": {
      const output = `${event.stdout}${event.stderr}`.trim();
      return output ? output.split("\n").map((text) => ({ text, fg: colors.muted })) : [];
    }
    case "message": {
      const fg =
        event.tone === "error"
          ? colors.error
          : event.tone === "success"
            ? colors.green
            : event.tone === "warning"
              ? colors.yellow
              : event.tone === "dim"
                ? colors.muted
                : colors.text;
      return event.message.split("\n").map((text) => ({ text, fg }));
    }
  }
}

/** Live output of `slinky sync`, the same events the CLI prints. */
export function SyncModal({ cols, rows, flow }: { cols: number; rows: number; flow: SyncFlow }) {
  const { contentWidth } = modalInner(WIDTH, cols);
  const lines = flow.events.flatMap(eventLines);
  if (flow.error) lines.push({ text: flow.error, fg: colors.error });
  const maxRows = syncLogRows(rows);
  const top = Math.max(0, lines.length - maxRows);
  const start = flow.scroll === null ? top : Math.min(flow.scroll, top);
  const visible = lines.slice(start, start + maxRows);
  const status = flow.running ? "working" : flow.error ? "failed" : "done";
  const position = lines.length > maxRows ? ` · ${start + 1}-${start + visible.length}/${lines.length}` : "";
  return (
    <Modal
      title="Sync"
      headerRight={`${status}${position}`}
      subtitle={<TextLine fg={colors.muted}>{"Save, pull, reconcile, and restore live vendor drift"}</TextLine>}
      width={WIDTH}
      cols={cols}
      rows={rows}
      bodyRows={Math.max(1, visible.length)}
      footer={[
        { key: "j/k", label: "scroll", when: lines.length > maxRows },
        { key: "g/G", label: "top/end", when: lines.length > maxRows },
        { key: "…", label: "please wait", disabled: true, when: flow.running },
        { key: "esc", label: "close", when: !flow.running },
      ]}
    >
      {visible.length === 0 ? <TextLine fg={colors.muted}>{"starting…"}</TextLine> : null}
      {visible.map((line, index) => (
        <TextLine key={index} fg={line.fg}>
          <span attributes={line.bold ? TextAttributes.BOLD : 0}>{fitCell(line.text, contentWidth)}</span>
        </TextLine>
      ))}
    </Modal>
  );
}
