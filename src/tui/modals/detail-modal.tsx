/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import { formatUtc } from "../../domain/model.ts";
import { liveColor, liveLabel } from "../app.tsx";
import { Field, Modal, TextLine, modalInner } from "../components.tsx";
import { linksForSkill, skillDescription } from "../data.ts";
import type { Catalog, CatalogRow } from "../data.ts";
import { colors } from "../theme.ts";
import { wrapText } from "../util.ts";

const WIDTH = 76;

export function DetailModal({ cols, rows, row, catalog }: { cols: number; rows: number; row: CatalogRow; catalog: Catalog }) {
  const { contentWidth } = modalInner(WIDTH, cols);
  const desc = skillDescription(catalog.repo, row.meta);
  const links = linksForSkill(catalog.state, row.name);
  const upstream = row.meta.origin === "vendor" ? row.meta.upstream : null;
  const source = upstream?.kind === "github" ? upstream.repository : upstream?.kind === "well-known" ? upstream.source : null;
  const sourceUrl = upstream?.kind === "unknown" ? null : upstream?.url;

  const here = row.projectLink
    ? {
        value: `${row.projectSkill ? `${row.projectLink.mode} · ${row.projectLink.excludedTargets.includes(`.agents/skills/${row.name}`) ? "hidden" : "tracked"}` : "missing"} · ${catalog.project}`,
        fg: row.projectSkill ? colors.link : colors.red,
      }
    : row.projectSkill
      ? {
          value: `unmanaged (${[row.projectSkill.agents ? ".agents" : "", row.projectSkill.claude ? ".claude" : ""].filter(Boolean).join(" + ")}) · ${catalog.project}`,
          fg: colors.yellow,
        }
      : { value: "not present", fg: colors.muted };

  const lines: ReactNode[] = [];
  if (desc) {
    for (const [index, line] of wrapText(desc, contentWidth).entries()) lines.push(<TextLine key={`desc-${index}`}>{line}</TextLine>);
    lines.push(<box key="desc-gap" height={1} />);
  }
  lines.push(<Field key="origin" label="origin" value={row.origin} />);
  lines.push(<Field key="path" label="path" value={row.meta.path} />);
  if (source) lines.push(<Field key="source" label="source" value={source} />);
  if (sourceUrl) lines.push(<Field key="url" label="url" value={sourceUrl} fg={colors.link} />);
  lines.push(<Field key="enabled" label="enabled" value={row.enabled ? "yes" : "no"} fg={row.enabled ? colors.green : colors.muted} />);
  lines.push(<Field key="live" label="live" value={liveLabel[row.live]} fg={liveColor(row.live)} />);
  lines.push(<Field key="claude" label="claude" value={row.claude ? "linked" : "not linked"} />);
  lines.push(<Field key="here" label="here" value={here.value} fg={here.fg} />);
  lines.push(<Field key="hash" label="hash" value={`${row.meta.contentHash.slice(0, 16)}\u2026`} />);
  if (row.meta.origin === "vendor" && row.meta.vendoredAt) lines.push(<Field key="vendored" label="vendored" value={formatUtc(row.meta.vendoredAt).slice(0, 10)} />);
  if (links.length > 0) {
    lines.push(<box key="links-gap" height={1} />);
    lines.push(
      <TextLine key="links" fg={colors.muted}>
        PROJECT LINKS
      </TextLine>,
    );
    for (const link of links) {
      lines.push(
        <TextLine key={`link-${link.project}`}>
          <span fg={colors.text}>{`  ${link.project}`}</span>
          <span fg={colors.muted}>{` (${link.mode})`}</span>
        </TextLine>,
      );
    }
  }

  return (
    <Modal title={row.name} headerRight={row.origin} width={WIDTH} cols={cols} rows={rows} bodyRows={lines.length} footer={[{ key: "esc", label: "close" }]}>
      {lines}
    </Modal>
  );
}
