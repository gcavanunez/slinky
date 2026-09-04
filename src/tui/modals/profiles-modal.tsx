/** @jsxImportSource @opentui/react */
import { getActiveProfile, getProfile } from "../../domain/model.ts";
import { Modal, TextLine } from "../components.tsx";
import type { Catalog } from "../data.ts";
import { colors } from "../theme.ts";
import { fitCell } from "../util.ts";

export function ProfilesModal({ cols, catalog, names, index }: { cols: number; catalog: Catalog; names: string[]; index: number }) {
  return (
    <Modal title="profiles" width={56} cols={cols}>
      {names.map((name, i) => {
        const isSel = i === index;
        const active = getActiveProfile(catalog.manifest, catalog.state) === name;
        const members = getProfile(catalog.manifest, name) ?? [];
        return (
          <TextLine key={name} fg={isSel ? colors.selectedText : colors.text} bg={isSel ? colors.selectedBg : undefined}>
            <span>{` ${fitCell(name, 20)}`}</span>
            <span fg={colors.muted}>{fitCell(`${members.length} skills`, 12)}</span>
            <span fg={colors.green}>{active ? "active" : ""}</span>
          </TextLine>
        );
      })}
      <TextLine fg={colors.yellow}>{"applying a profile disables everything outside it"}</TextLine>
      <TextLine fg={colors.muted}>{"enter apply · esc close"}</TextLine>
    </Modal>
  );
}
