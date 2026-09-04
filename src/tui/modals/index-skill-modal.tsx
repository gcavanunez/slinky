/** @jsxImportSource @opentui/react */
import type { UnindexedSkill } from "../../lib/adopt.ts";
import type { IndexFlow } from "../app.tsx";
import { Modal, TextLine } from "../components.tsx";
import { colors } from "../theme.ts";

export function IndexSkillModal({ cols, rows, skill, flow }: { cols: number; rows: number; skill: UnindexedSkill; flow: IndexFlow }) {
  const bodyRows = 3 + (flow.running ? 1 : 0) + (flow.error ? 1 : 0);
  return (
    <Modal
      title={`Index ${skill.name}`}
      headerRight={flow.running ? "working" : undefined}
      subtitle={
        <TextLine fg={colors.muted}>
          <span>{"source: "}</span>
          <span fg={colors.text}>{skill.path}</span>
        </TextLine>
      }
      width={86}
      cols={cols}
      rows={rows}
      bodyRows={bodyRows}
      footer={
        flow.running
          ? [{ key: "…", label: "please wait", disabled: true }]
          : [
              { key: "enter", label: "index" },
              { key: "esc", label: "cancel" },
            ]
      }
    >
      <TextLine fg={colors.muted}>{"skills.sh source or add command"}</TextLine>
      <TextLine>
        <span fg={colors.count}>{"> "}</span>
        <span fg={colors.text}>{flow.input}</span>
        {flow.running ? null : (
          <span bg={colors.accent} fg={colors.background}>
            {" "}
          </span>
        )}
      </TextLine>
      <TextLine fg={colors.muted}>{`example: skills add kitlangton/skills --skill ${skill.name}`}</TextLine>
      {flow.running ? <TextLine fg={colors.yellow}>{"installing, indexing, and syncing..."}</TextLine> : null}
      {flow.error ? <TextLine fg={colors.error}>{flow.error}</TextLine> : null}
    </Modal>
  );
}
