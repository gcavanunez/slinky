/** @jsxImportSource @opentui/react */
import type { LinkFlow } from "../app.tsx";
import { Modal, TextLine } from "../components.tsx";
import type { CatalogRow } from "../data.ts";
import { colors } from "../theme.ts";

export function LinkModal({ cols, row, flow, recents }: { cols: number; row: CatalogRow; flow: LinkFlow; recents: ReadonlyArray<string> }) {
  return (
    <Modal title={`link ${row.name}`} width={76} cols={cols}>
      {flow.step === "project" ? (
        <box flexDirection="column">
          <TextLine fg={colors.muted}>{"project directory:"}</TextLine>
          <TextLine>
            <span fg={colors.accent}>{" > "}</span>
            <span fg={colors.text}>{flow.input}</span>
            <span fg={colors.accent}>{"\u2588"}</span>
          </TextLine>
          {flow.error ? <TextLine fg={colors.red}>{` ${flow.error}`}</TextLine> : null}
          {recents.length > 0 ? (
            <box flexDirection="column" paddingTop={1}>
              <TextLine fg={colors.muted}>{"recent (up/down):"}</TextLine>
              {recents.slice(0, 5).map((p, i) => (
                <TextLine key={p} fg={i === flow.recentIndex ? colors.selectedText : colors.muted} bg={i === flow.recentIndex ? colors.selectedBg : undefined}>
                  {`  ${p}`}
                </TextLine>
              ))}
            </box>
          ) : null}
          <TextLine fg={colors.muted}>{"enter continue · esc cancel"}</TextLine>
        </box>
      ) : null}
      {flow.step === "mode" ? (
        <box flexDirection="column">
          <TextLine fg={colors.muted}>{`into ${flow.input}`}</TextLine>
          <TextLine fg={flow.mode === "copy" ? colors.selectedText : colors.muted} bg={flow.mode === "copy" ? colors.selectedBg : undefined}>
            {" copy     snapshot; project owns its copy (drift is tracked)"}
          </TextLine>
          <TextLine fg={flow.mode === "symlink" ? colors.selectedText : colors.muted} bg={flow.mode === "symlink" ? colors.selectedBg : undefined}>
            {" symlink  live; project always sees the repo version"}
          </TextLine>
          <TextLine fg={colors.muted}>{"j/k or c/s choose · enter continue · esc cancel"}</TextLine>
        </box>
      ) : null}
      {flow.step === "options" ? (
        <box flexDirection="column">
          <TextLine fg={colors.muted}>{`${flow.mode} into ${flow.input}`}</TextLine>
          <TextLine>
            <span fg={colors.accent}>{" e "}</span>
            <span fg={colors.text}>{`[${flow.exclude ? "x" : " "}] add to .git/info/exclude`}</span>
          </TextLine>
          <TextLine>
            <span fg={colors.accent}>{" c "}</span>
            <span fg={colors.text}>{`[${flow.claude ? "x" : " "}] .claude/skills symlink (when .claude exists)`}</span>
          </TextLine>
          <TextLine fg={colors.muted}>{"enter link it · esc cancel"}</TextLine>
        </box>
      ) : null}
    </Modal>
  );
}
