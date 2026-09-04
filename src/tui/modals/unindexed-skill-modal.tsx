/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import type { UnindexedSkill } from "../../lib/adopt.ts";
import { Field, Modal, TextLine, modalInner } from "../components.tsx";
import { unindexedSkillDescription } from "../data.ts";
import { colors } from "../theme.ts";
import { wrapText } from "../util.ts";

const WIDTH = 76;

export function UnindexedSkillModal({ cols, rows, skill }: { cols: number; rows: number; skill: UnindexedSkill }) {
  const { contentWidth } = modalInner(WIDTH, cols);
  const desc = unindexedSkillDescription(skill);
  const lines: ReactNode[] = [];
  if (desc) {
    for (const [index, line] of wrapText(desc, contentWidth).entries()) lines.push(<TextLine key={`desc-${index}`}>{line}</TextLine>);
    lines.push(<box key="desc-gap" height={1} />);
  }
  lines.push(<Field key="origin" label="origin" value={skill.origin} />);
  lines.push(<Field key="path" label="path" value={skill.path} fg={colors.link} />);
  lines.push(<Field key="catalog" label="catalog" value="present in the host but absent from skills.manifest.json" fg={colors.yellow} />);
  return (
    <Modal
      title={skill.name}
      headerRight="unindexed"
      subtitle={<TextLine fg={colors.muted}>{"Close, then press a to index it with a skills.sh source"}</TextLine>}
      width={WIDTH}
      cols={cols}
      rows={rows}
      bodyRows={lines.length}
      footer={[{ key: "esc", label: "close" }]}
    >
      {lines}
    </Modal>
  );
}
