/** @jsxImportSource @opentui/react */
import { Modal, TextLine } from "../components.tsx";
import { colors } from "../theme.ts";
import { fitCell } from "../util.ts";

/** Help body rows at this terminal height; App clamps scrolling with it. */
export function helpRows(rows: number): number {
  return Math.max(1, rows - 8);
}

function helpGroups(editor: string): Array<{ title: string; lines: Array<[string, string]> }> {
  return [
    {
      title: "NAVIGATE",
      lines: [
        ["h/l, left/right", "focus the previous or next panel"],
        ["tab", "focus the next panel, wrapping at the end"],
        ["j/k, up/down", "move or scroll within the focused panel"],
        ["h / l", "in the catalog: jump to or fold the heading / unfold it"],
        ["z / Z", "fold the current group / fold every group"],
        ["0 / $", "focus the first / last panel"],
        ["gg / G", "first / last item or document boundary"],
        ["ctrl-d / ctrl-u", "half-page down / up"],
        ["ctrl-f / ctrl-b", "full page down / up"],
        ["ctrl-e / ctrl-y", "scroll the document one line from any panel"],
        ["J / K, PgUp/PgDn", "scroll the document from any panel"],
        ["[ / ]", "previous / next related file"],
        ["f", "show / hide SKILL.md frontmatter"],
        ["{ / }", "previous / next markdown heading in the document"],
        ["n / N", "next / previous document search match"],
        ["enter", "fold a group, enter the next panel, or from the document show details"],
      ],
    },
    {
      title: "LAYOUT",
      lines: [
        ["x", "expand or restore the focused pane"],
        ["v / V", "cycle layouts: split, catalog only, document only"],
        ["< / >", "shrink / grow the focused side of the split"],
        ["1 / 2", "available here / all skills view"],
        ["/", "filter lists; in the document pane, search the document"],
        ["t", "pick a colour theme"],
      ],
    },
    {
      title: "ACT",
      lines: [
        ["i", "show skill details; on a heading, summarise the group"],
        ["e", `edit a local or unindexed host skill in ${editor}`],
        ["a", "index selected unindexed .agents skill"],
        ["space", "toggle a skill, or every skill in the group from its heading"],
        ["u", "check vendor skills for upstream updates"],
        ["S", "sync the store: save, pull, reconcile, restore (j/k scroll its log)"],
        ["L", "link skill into a project (copy or symlink)"],
        ["d", "diff live global copy vs repo baseline"],
        ["p", "profile picker (exact-set apply)"],
        ["r", "reload catalog"],
        ["drag / ctrl-c", "copy selected text to clipboard"],
        ["q / ctrl-c", "quit (ctrl-c only without a text selection)"],
        ["mouse", "click rows/tabs/panels; drag text to copy; wheel scrolls"],
      ],
    },
  ];
}

/** Rows the help body needs: every line plus a blank between groups. */
export function helpLength(editor: string): number {
  return helpGroups(editor).reduce((sum, group, index) => sum + group.lines.length + 1 + (index > 0 ? 1 : 0), 0);
}

export function HelpModal({ cols, rows, editor, scroll }: { cols: number; rows: number; editor: string; scroll: number }) {
  const groups = helpGroups(editor);
  const all = groups.flatMap((group, index) => [
    ...(index > 0 ? [<box key={`gap-${group.title}`} height={1} />] : []),
    <TextLine key={group.title} fg={colors.muted}>
      {group.title}
    </TextLine>,
    ...group.lines.map(([keys, label]) => (
      <TextLine key={keys}>
        <span fg={colors.count}>{fitCell(keys, 18)}</span>
        <span fg={colors.text}>{label}</span>
      </TextLine>
    )),
  ]);
  const bodyRows = Math.min(all.length, helpRows(rows));
  const start = Math.max(0, Math.min(scroll, all.length - bodyRows));
  const overflow = all.length > bodyRows;
  return (
    <Modal
      title="Help"
      headerRight={overflow ? `${start + 1}-${start + bodyRows}/${all.length}` : undefined}
      width={76}
      cols={cols}
      rows={rows}
      bodyRows={bodyRows}
      footer={[
        { key: "j/k", label: "scroll", when: overflow },
        { key: "? / esc", label: "close" },
      ]}
    >
      {all.slice(start, start + bodyRows)}
    </Modal>
  );
}
