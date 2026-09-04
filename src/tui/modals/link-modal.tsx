/** @jsxImportSource @opentui/react */
import type { LinkFlow } from "../app.tsx";
import { Modal, TextLine } from "../components.tsx";
import type { CatalogRow } from "../data.ts";
import { colors } from "../theme.ts";

const WIDTH = 76;

function Caret() {
  return (
    <span bg={colors.accent} fg={colors.background}>
      {" "}
    </span>
  );
}

export function LinkModal({ cols, rows, row, flow, recents }: { cols: number; rows: number; row: CatalogRow; flow: LinkFlow; recents: ReadonlyArray<string> }) {
  const title = `Link ${row.name}`;
  const step = flow.step === "project" ? "1/3" : flow.step === "mode" ? "2/3" : "3/3";
  if (flow.step === "project") {
    const recent = recents.slice(0, 5);
    const bodyRows = 1 + (flow.error ? 1 : 0) + (recent.length > 0 ? recent.length + 2 : 0);
    return (
      <Modal
        title={title}
        headerRight={step}
        subtitle={<TextLine fg={colors.muted}>{"Project directory"}</TextLine>}
        width={WIDTH}
        cols={cols}
        rows={rows}
        bodyRows={bodyRows}
        footer={[
          { key: "↑↓", label: "recent", when: recent.length > 0 },
          { key: "enter", label: "continue" },
          { key: "esc", label: "cancel" },
        ]}
      >
        <TextLine>
          <span fg={colors.count}>{"> "}</span>
          <span fg={colors.text}>{flow.input}</span>
          <Caret />
        </TextLine>
        {flow.error ? <TextLine fg={colors.error}>{flow.error}</TextLine> : null}
        {recent.length > 0 ? (
          <>
            <box height={1} />
            <TextLine fg={colors.muted}>{"RECENT"}</TextLine>
            {recent.map((p, i) => {
              const selected = i === flow.recentIndex;
              return (
                <TextLine key={p} fg={selected ? colors.selectedText : colors.text} bg={selected ? colors.selectedBg : undefined}>
                  <span fg={selected ? colors.accent : colors.muted}>{selected ? "› " : "  "}</span>
                  <span>{p}</span>
                </TextLine>
              );
            })}
          </>
        ) : null}
      </Modal>
    );
  }
  if (flow.step === "mode") {
    const option = (mode: LinkFlow["mode"], label: string, detail: string) => {
      const selected = flow.mode === mode;
      return (
        <TextLine fg={selected ? colors.selectedText : colors.text} bg={selected ? colors.selectedBg : undefined}>
          <span fg={selected ? colors.accent : colors.muted}>{selected ? "● " : "○ "}</span>
          <span>{label.padEnd(9)}</span>
          <span fg={colors.muted}>{detail}</span>
        </TextLine>
      );
    };
    return (
      <Modal
        title={title}
        headerRight={step}
        subtitle={
          <TextLine fg={colors.muted}>
            <span>{"Into "}</span>
            <span fg={colors.text}>{flow.input}</span>
          </TextLine>
        }
        width={WIDTH}
        cols={cols}
        rows={rows}
        bodyRows={2}
        footer={[
          { key: "j/k", label: "choose" },
          { key: "c/s", label: "copy / symlink" },
          { key: "enter", label: "continue" },
          { key: "esc", label: "cancel" },
        ]}
      >
        {option("copy", "copy", "snapshot; project owns its copy (drift is tracked)")}
        {option("symlink", "symlink", "live; project always sees the repo version")}
      </Modal>
    );
  }
  const check = (key: string, on: boolean, label: string) => (
    <TextLine>
      <span fg={colors.count}>{`${key} `}</span>
      <span fg={on ? colors.green : colors.muted}>{on ? "☑ " : "☐ "}</span>
      <span fg={colors.text}>{label}</span>
    </TextLine>
  );
  return (
    <Modal
      title={title}
      headerRight={step}
      subtitle={
        <TextLine fg={colors.muted}>
          <span fg={colors.text}>{flow.mode}</span>
          <span>{" into "}</span>
          <span fg={colors.text}>{flow.input}</span>
        </TextLine>
      }
      width={WIDTH}
      cols={cols}
      rows={rows}
      bodyRows={2}
      footer={[
        { key: "e/c", label: "toggle" },
        { key: "enter", label: "link it" },
        { key: "esc", label: "cancel" },
      ]}
    >
      {check("e", flow.exclude, "add to .git/info/exclude")}
      {check("c", flow.claude, ".claude/skills symlink (when .claude exists)")}
    </Modal>
  );
}
