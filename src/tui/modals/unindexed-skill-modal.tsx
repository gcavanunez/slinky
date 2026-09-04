/** @jsxImportSource @opentui/react */
import type { UnindexedSkill } from "../../lib/adopt.ts";
import { Modal, TextLine } from "../components.tsx";
import { unindexedSkillDescription } from "../data.ts";
import { colors } from "../theme.ts";
import { fitCell } from "../util.ts";

export function UnindexedSkillModal({ cols, skill }: { cols: number; skill: UnindexedSkill }) {
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
