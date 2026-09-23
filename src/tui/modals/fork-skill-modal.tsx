/** @jsxImportSource @opentui/react */
import type { ForkFlow } from "../app.tsx";
import { Modal, TextLine } from "../components.tsx";
import type { CatalogRow } from "../data.ts";
import { colors } from "../theme.ts";

export function ForkSkillModal({ cols, rows, row, flow }: { cols: number; rows: number; row: CatalogRow; flow: ForkFlow }) {
  const bodyRows = 3 + (flow.running ? 1 : 0) + (flow.error ? 1 : 0);
  return (
    <Modal
      title={`Fork ${row.name}`}
      headerRight={flow.running ? "working" : undefined}
      subtitle={
        <TextLine fg={colors.muted}>
          <span>{"source: "}</span>
          <span fg={colors.text}>{row.meta.path}</span>
        </TextLine>
      }
      width={72}
      cols={cols}
      rows={rows}
      bodyRows={bodyRows}
      footer={
        flow.running
          ? [{ key: "…", label: "please wait", disabled: true }]
          : [
              { key: "enter", label: "fork" },
              { key: "esc", label: "cancel" },
            ]
      }
    >
      <TextLine fg={colors.muted}>{"name for the local copy"}</TextLine>
      <TextLine>
        <span fg={colors.count}>{"> "}</span>
        <span fg={colors.text}>{flow.input}</span>
        {flow.running ? null : (
          <span bg={colors.accent} fg={colors.background}>
            {" "}
          </span>
        )}
      </TextLine>
      <TextLine fg={colors.muted}>{`copies the committed baseline to skills/${flow.input || "<name>"}; ${row.name} stays vendored`}</TextLine>
      {flow.running ? <TextLine fg={colors.yellow}>{"copying, indexing, and syncing..."}</TextLine> : null}
      {flow.error ? <TextLine fg={colors.error}>{flow.error}</TextLine> : null}
    </Modal>
  );
}
