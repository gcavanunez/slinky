/** @jsxImportSource @opentui/react */
import type { ThemeId } from "../../domain/model.ts";
import { Modal, TextLine, modalInner } from "../components.tsx";
import { colors, themeList } from "../theme.ts";
import { fitCell, windowOf } from "../util.ts";

const WIDTH = 58;
const SWATCHES = 6;

/** Theme picker. The highlighted theme is already applied live; `saved` is what esc restores. */
export function ThemeModal({ cols, rows, index, saved }: { cols: number; rows: number; index: number; saved: ThemeId }) {
  const { contentWidth } = modalInner(WIDTH, cols);
  const bodyRows = Math.max(3, Math.min(themeList.length, rows - 9));
  const start = windowOf(0, index, themeList.length, bodyRows);
  const selected = themeList[index];
  const nameWidth = Math.max(8, contentWidth - 2 - SWATCHES - 1 - 6);
  return (
    <Modal
      title="Themes"
      headerRight={`${index + 1}/${themeList.length}`}
      subtitle={<TextLine fg={colors.muted}>{fitCell(selected?.description ?? "", contentWidth)}</TextLine>}
      width={WIDTH}
      cols={cols}
      rows={rows}
      bodyRows={bodyRows}
      footer={[
        { key: "↑↓", label: "preview" },
        { key: "enter", label: "save" },
        { key: "esc", label: "cancel" },
      ]}
    >
      {themeList.slice(start, start + bodyRows).map((theme, offset) => {
        const i = start + offset;
        const isSel = i === index;
        const isSaved = theme.id === saved;
        return (
          <TextLine key={theme.id} fg={isSel ? colors.selectedText : colors.text} bg={isSel ? colors.selectedBg : undefined}>
            <span fg={isSaved ? colors.green : colors.muted}>{isSaved ? "✓ " : "  "}</span>
            <span>{fitCell(theme.name, nameWidth)}</span>
            <span fg={colors.muted}>{fitCell(theme.tone, 6)}</span>
            <span> </span>
            <span bg={theme.colors.background}> </span>
            <span bg={theme.colors.modalBackground}> </span>
            <span bg={theme.colors.accent}> </span>
            <span bg={theme.colors.green}> </span>
            <span bg={theme.colors.red}> </span>
            <span bg={theme.colors.link}> </span>
          </TextLine>
        );
      })}
    </Modal>
  );
}
