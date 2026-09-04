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
}

const WIDTH = 86;

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
  const maxRows = Math.max(3, rows - 9);
  const visible = lines.slice(Math.max(0, lines.length - maxRows));
  return (
    <Modal
      title="Sync"
      headerRight={flow.running ? "working" : flow.error ? "failed" : "done"}
      subtitle={<TextLine fg={colors.muted}>{"Save, pull, reconcile, and restore live vendor drift"}</TextLine>}
      width={WIDTH}
      cols={cols}
      rows={rows}
      bodyRows={Math.max(1, visible.length)}
      footer={flow.running ? [{ key: "…", label: "please wait", disabled: true }] : [{ key: "esc", label: "close" }]}
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
