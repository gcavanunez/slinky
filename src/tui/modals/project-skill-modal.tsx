/** @jsxImportSource @opentui/react */
import { Modal, TextLine } from "../components.tsx";
import { projectSkillDescription, projectSkillPath } from "../data.ts";
import type { Catalog, ProjectSkill } from "../data.ts";
import { colors } from "../theme.ts";
import { fitCell } from "../util.ts";

export function ProjectSkillModal({ cols, skill, catalog }: { cols: number; skill: ProjectSkill; catalog: Catalog }) {
  const desc = projectSkillDescription(catalog.project, skill);
  const stores = [skill.agents ? ".agents" : "", skill.claude ? ".claude" : ""].filter(Boolean).join(" + ");
  const field = (label: string, value: string, fg: string = colors.text) => (
    <TextLine key={label}>
      <span fg={colors.muted}>{fitCell(label, 12)}</span>
      <span fg={fg}>{value}</span>
    </TextLine>
  );
  return (
    <Modal title={`${skill.name} · project only`} width={76} cols={cols}>
      {desc ? (
        <box paddingBottom={1}>
          <text fg={colors.text} wrapMode="word">
            {desc}
          </text>
        </box>
      ) : null}
      {field("project", catalog.project)}
      {field("stores", stores)}
      {field("source", projectSkillPath(catalog.project, skill), colors.accent)}
      {field("catalog", "not managed by Slinky", colors.yellow)}
      <TextLine fg={colors.muted}>{"esc to close · use the document panel to review files"}</TextLine>
    </Modal>
  );
}
