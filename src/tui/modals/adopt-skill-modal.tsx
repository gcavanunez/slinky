/** @jsxImportSource @opentui/react */
import type { ForeignSkill } from "../../lib/adopt.ts";
import { adoptDestination } from "../../lib/adopt.ts";
import type { AdoptFlow } from "../app.tsx";
import { Field, Modal, TextLine } from "../components.tsx";
import { foreignSkillLocation } from "../data.ts";
import { colors } from "../theme.ts";

export function AdoptSkillModal({ cols, rows, skill, flow }: { cols: number; rows: number; skill: ForeignSkill; flow: AdoptFlow }) {
  const local = flow.origin === "local";
  const destination = adoptDestination(skill, { local });
  const bodyRows = 7 + (flow.running ? 1 : 0) + (flow.error ? 1 : 0);
  return (
    <Modal
      title={`Adopt ${skill.name}`}
      headerRight={flow.running ? "working" : "to adopt"}
      subtitle={<TextLine fg={colors.muted}>{`${foreignSkillLocation(skill)} · ${skill.lock?.source ?? "unknown source"}`}</TextLine>}
      width={82}
      cols={cols}
      rows={rows}
      bodyRows={bodyRows}
      footer={
        flow.running
          ? [{ key: "…", label: "please wait", disabled: true }]
          : [
              { key: "j/k", label: "choose" },
              { key: "enter", label: "adopt" },
              { key: "esc", label: "cancel" },
            ]
      }
    >
      <TextLine fg={local ? colors.muted : colors.text}>{`${local ? "○" : "●"} vendor  keep an external baseline in the catalog`}</TextLine>
      <TextLine fg={local ? colors.text : colors.muted}>{`${local ? "●" : "○"} local   treat this as a skill you maintain`}</TextLine>
      <box height={1} />
      <Field label="from" value={skill.dir} fg={colors.link} />
      <Field label="to" value={destination} fg={colors.link} />
      {!skill.lock && !local ? <TextLine fg={colors.yellow}>{"No skills.sh provenance; this will be stored under vendor/_unknown."}</TextLine> : <box height={1} />}
      <TextLine fg={colors.muted}>{"The live copy is moved only after the catalog entry is saved."}</TextLine>
      {flow.running ? <TextLine fg={colors.yellow}>{"adopting and reconciling…"}</TextLine> : null}
      {flow.error ? <TextLine fg={colors.error}>{flow.error}</TextLine> : null}
    </Modal>
  );
}
