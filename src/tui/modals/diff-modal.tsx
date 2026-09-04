/** @jsxImportSource @opentui/react */
import type { DirDiff } from "../../lib/diff.ts";
import { Modal, TextLine } from "../components.tsx";
import type { CatalogRow, DiffResult } from "../data.ts";
import { colors } from "../theme.ts";

export function DiffModal({ cols, row, result }: { cols: number; row: CatalogRow; result: DiffResult }) {
  if (result.kind === "local") {
    return (
      <Modal title={`diff ${row.name}`} width={64} cols={cols}>
        <TextLine fg={colors.muted}>{"local skill: lives in the repo, nothing to diff"}</TextLine>
        <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
      </Modal>
    );
  }
  if (result.kind === "not-installed") {
    return (
      <Modal title={`diff ${row.name}`} width={64} cols={cols}>
        <TextLine fg={colors.muted}>{"not installed globally (disabled?)"}</TextLine>
        <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
      </Modal>
    );
  }
  if (result.kind === "unowned") {
    return (
      <Modal title={`diff ${row.name}`} width={64} cols={cols}>
        <TextLine fg={colors.yellow}>{"live path is not owned by this catalog"}</TextLine>
        <TextLine fg={colors.muted}>{"inspect it before using --force"}</TextLine>
        <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
      </Modal>
    );
  }
  const d: DirDiff = result.diff;
  const cap = 14;
  const entries: Array<{ sign: string; fg: string; file: string }> = [
    ...d.added.map((f) => ({ sign: "+", fg: colors.green, file: f })),
    ...d.removed.map((f) => ({ sign: "-", fg: colors.red, file: f })),
    ...d.modified.map((f) => ({ sign: "~", fg: colors.yellow, file: f })),
  ];
  return (
    <Modal title={`diff ${row.name}`} width={76} cols={cols}>
      {entries.length === 0 ? (
        <TextLine fg={colors.green}>{`in sync (${d.unchanged} files match the repo baseline)`}</TextLine>
      ) : (
        <box flexDirection="column">
          <TextLine fg={colors.yellow}>{"live global copy differs from repo baseline:"}</TextLine>
          {entries.slice(0, cap).map((e) => (
            <TextLine key={`${e.sign}${e.file}`}>
              <span fg={e.fg}>{` ${e.sign} ${e.file}`}</span>
            </TextLine>
          ))}
          {entries.length > cap ? <TextLine fg={colors.muted}>{`  \u2026 ${entries.length - cap} more`}</TextLine> : null}
          <TextLine>
            <span fg={colors.accent}>{"a"}</span>
            <span fg={colors.muted}>{" accept global  "}</span>
            <span fg={colors.accent}>{"r"}</span>
            <span fg={colors.muted}>{" restore baseline  "}</span>
            <span fg={colors.accent}>{"h"}</span>
            <span fg={colors.muted}>{" hunk  "}</span>
            <span fg={colors.accent}>{"d"}</span>
            <span fg={colors.muted}>{" delta"}</span>
          </TextLine>
        </box>
      )}
      <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
    </Modal>
  );
}
