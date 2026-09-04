/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import { Field, Modal, TextLine, modalInner } from "../components.tsx";
import { projectSkillDescription, projectSkillPath } from "../data.ts";
import type { Catalog, ProjectSkill } from "../data.ts";
import { colors } from "../theme.ts";
import { wrapText } from "../util.ts";

const WIDTH = 76;

export function ProjectSkillModal({ cols, rows, skill, catalog }: { cols: number; rows: number; skill: ProjectSkill; catalog: Catalog }) {
  const { contentWidth } = modalInner(WIDTH, cols);
  const desc = projectSkillDescription(catalog.project, skill);
  const stores = [skill.agents ? ".agents" : "", skill.claude ? ".claude" : ""].filter(Boolean).join(" + ");
  const lines: ReactNode[] = [];
  if (desc) {
    for (const [index, line] of wrapText(desc, contentWidth).entries()) lines.push(<TextLine key={`desc-${index}`}>{line}</TextLine>);
    lines.push(<box key="desc-gap" height={1} />);
  }
  lines.push(<Field key="project" label="project" value={catalog.project} />);
  lines.push(<Field key="stores" label="stores" value={stores} />);
  lines.push(<Field key="source" label="source" value={projectSkillPath(catalog.project, skill)} fg={colors.link} />);
  lines.push(<Field key="catalog" label="catalog" value="not managed by Slinky" fg={colors.yellow} />);
  return (
    <Modal
      title={skill.name}
      headerRight="project only"
      subtitle={<TextLine fg={colors.muted}>{"Use the document panel to review its files"}</TextLine>}
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
