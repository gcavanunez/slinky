/** @jsxImportSource @opentui/react */
import type { DirDiff } from "../../lib/diff.ts";
import { Modal, TextLine } from "../components.tsx";
import type { HintItem } from "../components.tsx";
import type { CatalogRow, DiffResult } from "../data.ts";
import { colors } from "../theme.ts";

const close: HintItem = { key: "esc", label: "close" };

export function DiffModal({ cols, rows, row, result }: { cols: number; rows: number; row: CatalogRow; result: DiffResult }) {
  const title = `Diff ${row.name}`;
  if (result.kind === "local") {
    return (
      <Modal title={title} width={64} cols={cols} rows={rows} bodyRows={1} footer={[close]}>
        <TextLine fg={colors.muted}>{"local skill: lives in the repo, nothing to diff"}</TextLine>
      </Modal>
    );
  }
  if (result.kind === "not-installed") {
    return (
      <Modal title={title} width={64} cols={cols} rows={rows} bodyRows={1} footer={[close]}>
        <TextLine fg={colors.muted}>{"not installed globally (disabled?)"}</TextLine>
      </Modal>
    );
  }
  if (result.kind === "unowned") {
    return (
      <Modal title={title} width={64} cols={cols} rows={rows} bodyRows={2} footer={[close]}>
        <TextLine fg={colors.yellow}>{"live path is not owned by this catalog"}</TextLine>
        <TextLine fg={colors.muted}>{"inspect it before using --force"}</TextLine>
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
  const clean = entries.length === 0;
  const shown = entries.slice(0, cap);
  const overflow = entries.length - shown.length;
  return (
    <Modal
      title={title}
      headerRight={clean ? "in sync" : `${entries.length} changed`}
      subtitle={
        <TextLine fg={clean ? colors.green : colors.yellow}>{clean ? `${d.unchanged} files match the repo baseline` : "live global copy differs from repo baseline"}</TextLine>
      }
      width={76}
      cols={cols}
      rows={rows}
      bodyRows={clean ? 1 : shown.length + (overflow > 0 ? 1 : 0)}
      footer={[
        { key: "a", label: "accept global", when: !clean },
        { key: "r", label: "restore baseline", when: !clean },
        { key: "h", label: "hunk", when: !clean },
        { key: "d", label: "delta", when: !clean },
        close,
      ]}
    >
      {clean ? (
        <TextLine fg={colors.muted}>{"Nothing to accept or restore."}</TextLine>
      ) : (
        <>
          {shown.map((e) => (
            <TextLine key={`${e.sign}${e.file}`}>
              <span fg={e.fg}>{`${e.sign} `}</span>
              <span fg={colors.text}>{e.file}</span>
            </TextLine>
          ))}
          {overflow > 0 ? <TextLine fg={colors.muted}>{`\u2026 ${overflow} more`}</TextLine> : null}
        </>
      )}
    </Modal>
  );
}
