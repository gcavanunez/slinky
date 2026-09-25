/** @jsxImportSource @opentui/react */
import { getActiveProfile, getProfile } from "../../domain/model.ts";
import { Modal, TextLine, modalInner } from "../components.tsx";
import type { Catalog } from "../data.ts";
import { colors } from "../theme.ts";
import { fitCell, windowOf } from "../util.ts";

export function ProfilesModal({ cols, rows, catalog, names, index }: { cols: number; rows: number; catalog: Catalog; names: string[]; index: number }) {
  const { contentWidth } = modalInner(64, cols);
  const active = getActiveProfile(catalog.manifest, catalog.state);
  // Modal chrome with a subtitle is 7 rows; keep the selection on screen.
  const bodyRows = Math.max(1, Math.min(names.length, rows - 9));
  const start = windowOf(0, index, names.length, bodyRows);
  const hasSelection = names.length > 0;
  return (
    <Modal
      title="Profiles"
      headerRight={hasSelection ? `${index + 1}/${names.length}` : undefined}
      subtitle={<TextLine fg={colors.muted}>{"Applying follows it exactly and clears local changes"}</TextLine>}
      width={64}
      cols={cols}
      rows={rows}
      bodyRows={bodyRows}
      footer={[
        { key: "enter", label: "apply", disabled: !hasSelection },
        { key: "n", label: "new" },
        { key: "e", label: "edit", disabled: !hasSelection },
        { key: "r", label: "rename", disabled: !hasSelection },
        { key: "d", label: "delete", disabled: !hasSelection },
        { key: "esc", label: "close" },
      ]}
    >
      {hasSelection ? null : <TextLine fg={colors.muted}>{"no profiles yet; n creates one from what is enabled here"}</TextLine>}
      {names.slice(start, start + bodyRows).map((name, offset) => {
        const i = start + offset;
        const isSel = i === index;
        const isActive = active === name;
        const members = getProfile(catalog.manifest, name) ?? [];
        return (
          <TextLine key={name} fg={isSel ? colors.selectedText : colors.text} bg={isSel ? colors.selectedBg : undefined}>
            <span fg={isActive ? colors.green : colors.muted}>{isActive ? "✓ " : "  "}</span>
            <span>{fitCell(name, Math.max(8, contentWidth - 16))}</span>
            <span fg={colors.muted}>{fitCell(`${members.length} skills`, 12, "right")}</span>
          </TextLine>
        );
      })}
    </Modal>
  );
}
