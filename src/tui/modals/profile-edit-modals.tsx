/** @jsxImportSource @opentui/react */
import type { ProfileNameFlow } from "../app.tsx";
import { Modal, TextLine, modalInner } from "../components.tsx";
import { colors } from "../theme.ts";
import { fitCell, windowOf } from "../util.ts";

export function ProfileNameModal({
  cols,
  rows,
  mode,
  from,
  flow,
  seedCount,
}: {
  cols: number;
  rows: number;
  mode: "create" | "rename";
  from: string | null;
  flow: ProfileNameFlow;
  seedCount: number;
}) {
  return (
    <Modal
      title={mode === "create" ? "New profile" : `Rename ${from ?? ""}`}
      subtitle={
        <TextLine fg={colors.muted}>
          {mode === "create" ? `starts with the ${seedCount} skills enabled on this machine` : "machines following it follow the new name after they sync"}
        </TextLine>
      }
      width={64}
      cols={cols}
      rows={rows}
      bodyRows={2 + (flow.error ? 1 : 0)}
      footer={[
        { key: "enter", label: mode === "create" ? "create" : "rename" },
        { key: "esc", label: "back" },
      ]}
    >
      <TextLine fg={colors.muted}>{"profile name (letters, digits, . _ -)"}</TextLine>
      <TextLine>
        <span fg={colors.count}>{"> "}</span>
        <span fg={colors.text}>{flow.input}</span>
        <span bg={colors.accent} fg={colors.background}>
          {" "}
        </span>
      </TextLine>
      {flow.error ? <TextLine fg={colors.error}>{flow.error}</TextLine> : null}
    </Modal>
  );
}

export function ProfileDeleteModal({ cols, rows, name, members, error }: { cols: number; rows: number; name: string; members: number; error?: string }) {
  return (
    <Modal
      title={`Delete ${name}?`}
      width={64}
      cols={cols}
      rows={rows}
      bodyRows={2 + (error ? 1 : 0)}
      footer={[
        { key: "y", label: "delete" },
        { key: "esc", label: "keep" },
      ]}
    >
      <TextLine fg={colors.text}>{`Removes the ${members}-skill profile from skills.manifest.json.`}</TextLine>
      <TextLine fg={colors.muted}>{"The skills stay in the catalog; machines following it keep their current skills."}</TextLine>
      {error ? <TextLine fg={colors.error}>{error}</TextLine> : null}
    </Modal>
  );
}

export function ProfileMembersModal({
  cols,
  rows,
  name,
  skills,
  members,
  index,
  error,
}: {
  cols: number;
  rows: number;
  name: string;
  skills: ReadonlyArray<string>;
  members: ReadonlyArray<string>;
  index: number;
  error?: string;
}) {
  const { contentWidth } = modalInner(64, cols);
  const chosen = new Set(members);
  // Modal chrome with a subtitle is 7 rows, plus the error line when shown.
  const bodyRows = Math.max(1, Math.min(skills.length, rows - 9 - (error ? 1 : 0)));
  const start = windowOf(0, index, skills.length, bodyRows);
  return (
    <Modal
      title={`Edit ${name}`}
      headerRight={`${chosen.size} on · ${skills.length === 0 ? 0 : index + 1}/${skills.length}`}
      subtitle={<TextLine fg={colors.muted}>{"which catalog skills this profile turns on"}</TextLine>}
      width={64}
      cols={cols}
      rows={rows}
      bodyRows={bodyRows + (error ? 1 : 0)}
      footer={[
        { key: "space", label: "toggle" },
        { key: "↑↓", label: "move" },
        { key: "enter", label: "save" },
        { key: "esc", label: "cancel" },
      ]}
    >
      {skills.slice(start, start + bodyRows).map((skill, offset) => {
        const i = start + offset;
        const isSel = i === index;
        const on = chosen.has(skill);
        return (
          <TextLine key={skill} fg={isSel ? colors.selectedText : colors.text} bg={isSel ? colors.selectedBg : undefined}>
            <span fg={on ? colors.green : colors.muted}>{on ? "[x] " : "[ ] "}</span>
            <span>{fitCell(skill, Math.max(8, contentWidth - 4))}</span>
          </TextLine>
        );
      })}
      {error ? <TextLine fg={colors.error}>{error}</TextLine> : null}
    </Modal>
  );
}
