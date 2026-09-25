/** @jsxImportSource @opentui/react */
import type { FleetMember } from "../../domain/model.ts";
import { Modal, TextLine, modalInner } from "../components.tsx";
import { colors } from "../theme.ts";
import { fitCell, windowOf } from "../util.ts";

export type FollowerCheck = { readonly kind: "checking" } | { readonly kind: "ok"; readonly version: string } | { readonly kind: "failed"; readonly detail: string };

export interface FollowerFormFields {
  readonly name: string;
  readonly ssh: string;
  readonly command: string;
}

export const followerFormLabels = ["name", "ssh target", "remote command"] as const;

const WIDTH = 78;

interface StatusCell {
  readonly text: string;
  readonly fg: string;
}

function checkCell(check: FollowerCheck | undefined): StatusCell {
  if (!check) return { text: "", fg: colors.muted };
  if (check.kind === "checking") return { text: "checking…", fg: colors.muted };
  if (check.kind === "ok") return { text: `ok ${check.version}`, fg: colors.green };
  return { text: "unreachable", fg: colors.error };
}

export function FleetModal({
  cols,
  rows,
  members,
  index,
  checks,
}: {
  cols: number;
  rows: number;
  members: ReadonlyArray<FleetMember>;
  index: number;
  checks: Readonly<Record<string, FollowerCheck>>;
}) {
  const { contentWidth } = modalInner(WIDTH, cols);
  const bodyRows = Math.max(1, Math.min(members.length, rows - 10));
  const start = windowOf(0, index, members.length, bodyRows);
  const selected = members[index];
  const failure = selected ? checks[selected.name] : undefined;
  const detail = failure?.kind === "failed" ? failure.detail.split("\n").find(Boolean) : undefined;
  const nameWidth = Math.max(8, ...members.map((member) => member.name.length)) + 2;
  const statusWidth = 16;
  return (
    <Modal
      title="Fleet"
      headerRight={members.length > 0 ? `${index + 1}/${members.length}` : undefined}
      subtitle={<TextLine fg={colors.muted}>{"Followers this machine syncs over ssh; S runs the fleet sync"}</TextLine>}
      width={WIDTH}
      cols={cols}
      rows={rows}
      bodyRows={bodyRows + (detail ? 1 : 0)}
      footer={[
        { key: "n", label: "add" },
        { key: "e", label: "edit", disabled: !selected },
        { key: "d", label: "remove", disabled: !selected },
        { key: "c", label: "check connections", disabled: members.length === 0 },
        { key: "esc", label: "close" },
      ]}
    >
      {members.length === 0 ? <TextLine fg={colors.muted}>{"no followers yet; n registers one"}</TextLine> : null}
      {members.slice(start, start + bodyRows).map((member, offset) => {
        const i = start + offset;
        const isSel = i === index;
        const status = checkCell(checks[member.name]);
        const target = member.command === undefined ? member.ssh : `${member.ssh}  (${member.command})`;
        return (
          <TextLine key={member.name} fg={isSel ? colors.selectedText : colors.text} bg={isSel ? colors.selectedBg : undefined}>
            <span>{fitCell(member.name, nameWidth)}</span>
            <span fg={isSel ? colors.selectedText : colors.muted}>{fitCell(target, Math.max(8, contentWidth - nameWidth - statusWidth))}</span>
            <span fg={status.fg}>{fitCell(status.text, statusWidth, "right")}</span>
          </TextLine>
        );
      })}
      {detail ? <TextLine fg={colors.error}>{fitCell(detail, contentWidth)}</TextLine> : null}
    </Modal>
  );
}

export function FollowerFormModal({
  cols,
  rows,
  previous,
  fields,
  field,
  error,
}: {
  cols: number;
  rows: number;
  previous: string | null;
  fields: FollowerFormFields;
  field: number;
  error?: string;
}) {
  const values = [fields.name, fields.ssh, fields.command];
  const hints = ["short label, e.g. mango", "what you'd type after `ssh`, e.g. me@mango", "blank = `slinky`; e.g. ~/.bun/bin/slinky"];
  return (
    <Modal
      title={previous === null ? "Add follower" : `Edit ${previous}`}
      subtitle={<TextLine fg={colors.muted}>{"fleet sync runs `<command> sync --follower` there over ssh"}</TextLine>}
      width={WIDTH}
      cols={cols}
      rows={rows}
      bodyRows={values.length * 2 + (error ? 1 : 0)}
      footer={[
        { key: "tab", label: "next field" },
        { key: "enter", label: "save" },
        { key: "esc", label: "back" },
      ]}
    >
      {values.flatMap((value, i) => [
        <TextLine key={`label-${i}`} fg={i === field ? colors.count : colors.muted}>
          <span>{`${followerFormLabels[i]}`}</span>
          <span fg={colors.muted}>{`  ${hints[i]}`}</span>
        </TextLine>,
        <TextLine key={`value-${i}`}>
          <span fg={i === field ? colors.count : colors.muted}>{i === field ? "> " : "  "}</span>
          <span fg={colors.text}>{value}</span>
          {i === field ? (
            <span bg={colors.accent} fg={colors.background}>
              {" "}
            </span>
          ) : null}
        </TextLine>,
      ])}
      {error ? <TextLine fg={colors.error}>{error}</TextLine> : null}
    </Modal>
  );
}

export function FollowerRemoveModal({ cols, rows, name, error }: { cols: number; rows: number; name: string; error?: string }) {
  return (
    <Modal
      title={`Remove ${name}?`}
      width={64}
      cols={cols}
      rows={rows}
      bodyRows={1 + (error ? 1 : 0)}
      footer={[
        { key: "y", label: "remove" },
        { key: "esc", label: "keep" },
      ]}
    >
      <TextLine fg={colors.text}>{"Stops syncing it from here; nothing changes on that machine."}</TextLine>
      {error ? <TextLine fg={colors.error}>{error}</TextLine> : null}
    </Modal>
  );
}
