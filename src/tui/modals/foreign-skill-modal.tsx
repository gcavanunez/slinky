/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import type { ForeignSkill } from "../../lib/adopt.ts";
import { Field, Modal, TextLine, modalInner } from "../components.tsx";
import { foreignSkillDescription, foreignSkillLocation } from "../data.ts";
import { colors } from "../theme.ts";
import { wrapText } from "../util.ts";

const WIDTH = 76;

export function ForeignSkillModal({ cols, rows, skill }: { cols: number; rows: number; skill: ForeignSkill }) {
  const { contentWidth } = modalInner(WIDTH, cols);
  const desc = foreignSkillDescription(skill);
  const lines: ReactNode[] = [];
  if (desc) {
    for (const [index, line] of wrapText(desc, contentWidth).entries()) lines.push(<TextLine key={`desc-${index}`}>{line}</TextLine>);
    lines.push(<box key="desc-gap" height={1} />);
  }
  lines.push(<Field key="location" label="location" value={foreignSkillLocation(skill)} />);
  lines.push(<Field key="path" label="path" value={skill.dir} fg={colors.link} />);
  lines.push(<Field key="source" label="source" value={skill.lock?.source ?? "unknown source"} fg={skill.lock ? colors.text : colors.yellow} />);
  lines.push(<Field key="catalog" label="catalog" value="installed globally but outside the catalog" fg={colors.yellow} />);
  return (
    <Modal
      title={skill.name}
      headerRight="to adopt"
      subtitle={<TextLine fg={colors.muted}>{"Close, then press a to adopt it into the catalog"}</TextLine>}
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
