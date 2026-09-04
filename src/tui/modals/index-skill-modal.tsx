/** @jsxImportSource @opentui/react */
import type { UnindexedSkill } from "../../lib/adopt.ts";
import type { IndexFlow } from "../app.tsx";
import { Modal, TextLine } from "../components.tsx";
import { colors } from "../theme.ts";

export function IndexSkillModal({ cols, skill, flow }: { cols: number; skill: UnindexedSkill; flow: IndexFlow }) {
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
