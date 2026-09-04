/** @jsxImportSource @opentui/react */
import { Modal, TextLine } from "../components.tsx";
import { colors } from "../theme.ts";
import { fitCell } from "../util.ts";

export function HelpModal({ cols, editor }: { cols: number; editor: string }) {
  const lines: Array<[string, string]> = [
    ["h/l, left/right", "focus the previous or next panel"],
    ["tab", "focus the next panel, wrapping at the end"],
    ["j/k, up/down", "move or scroll within the focused panel"],
    ["0 / $", "focus the first / last panel"],
    ["gg / G", "first / last item or document boundary"],
    ["ctrl-d / ctrl-u", "half-page down / up"],
    ["ctrl-f / ctrl-b", "full page down / up"],
    ["ctrl-e / ctrl-y", "scroll the document one line from any panel"],
    ["x", "expand or restore the focused primary panel"],
    ["v / V", "cycle layouts forward / backward: three, two, focused"],
    ["< / >", "shrink / grow the focused pane in a two-pane layout"],
    ["J / K, PgUp/PgDn", "scroll the document from any panel"],
    ["[ / ]", "previous / next related file"],
    ["{ / }", "previous / next markdown heading in the document"],
    ["n / N", "next / previous document search match"],
    ["enter", "enter the next panel; from document, show details"],
    ["i", "show skill details"],
    ["e", `edit a local or unindexed host skill in ${editor}`],
    ["1 / 2", "available here / all skills view"],
    ["a", "index selected unindexed .agents skill"],
    ["space", "toggle a skill or every skill by the focused author"],
    ["u", "check vendor skills for upstream updates"],
    ["L", "link skill into a project (copy or symlink)"],
    ["d", "diff live global copy vs repo baseline"],
    ["p", "profile picker (exact-set apply)"],
    ["/", "filter lists; in the document pane, search the document"],
    ["r", "reload catalog"],
    ["drag / ctrl-c", "copy selected text to clipboard"],
    ["q / ctrl-c", "quit (ctrl-c only without a text selection)"],
    ["mouse", "click rows/tabs/panels; drag text to copy; wheel scrolls"],
  ];
  return (
    <Modal title="help" width={76} cols={cols}>
      {lines.map(([keys, label]) => (
        <TextLine key={keys}>
          <span fg={colors.accent}>{fitCell(keys, 18)}</span>
          <span fg={colors.text}>{label}</span>
        </TextLine>
      ))}
      <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
    </Modal>
  );
}
