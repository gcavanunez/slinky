/** @jsxImportSource @opentui/react */
import { formatUtc } from "../../domain/model.ts";
import { liveColor, liveLabel } from "../app.tsx";
import { Modal, TextLine } from "../components.tsx";
import { linksForSkill, skillDescription } from "../data.ts";
import type { Catalog, CatalogRow } from "../data.ts";
import { colors } from "../theme.ts";
import { fitCell } from "../util.ts";

export function DetailModal({ cols, row, catalog }: { cols: number; row: CatalogRow; catalog: Catalog }) {
  const desc = skillDescription(catalog.repo, row.meta);
  const links = linksForSkill(catalog.state, row.name);
  const upstream = row.meta.origin === "vendor" ? row.meta.upstream : null;
  const source = upstream?.kind === "github" ? upstream.repository : upstream?.kind === "well-known" ? upstream.source : null;
  const sourceUrl = upstream?.kind === "unknown" ? null : upstream?.url;
  const field = (label: string, value: string, fg: string = colors.text) => (
    <TextLine key={label}>
      <span fg={colors.muted}>{fitCell(label, 12)}</span>
      <span fg={fg}>{value}</span>
    </TextLine>
  );
  return (
    <Modal title={row.name} width={76} cols={cols}>
      {desc ? (
        <box paddingBottom={1}>
          <text fg={colors.text} wrapMode="word">
            {desc}
          </text>
        </box>
      ) : null}
      {field("origin", row.origin)}
      {field("path", row.meta.path)}
      {source ? field("source", source) : null}
      {sourceUrl ? field("url", sourceUrl, colors.accent) : null}
      {field("enabled", row.enabled ? "yes" : "no", row.enabled ? colors.green : colors.muted)}
      {field("live", liveLabel[row.live], liveColor[row.live])}
      {field("claude", row.claude ? "linked" : "not linked")}
      {row.projectLink
        ? field(
            "here",
            `${row.projectSkill ? `${row.projectLink.mode} · ${row.projectLink.excludedTargets.includes(`.agents/skills/${row.name}`) ? "hidden" : "tracked"}` : "missing"} · ${catalog.project}`,
            row.projectSkill ? colors.accent : colors.red,
          )
        : row.projectSkill
          ? field(
              "here",
              `unmanaged (${[row.projectSkill.agents ? ".agents" : "", row.projectSkill.claude ? ".claude" : ""].filter(Boolean).join(" + ")}) · ${catalog.project}`,
              colors.yellow,
            )
          : field("here", "not present", colors.muted)}
      {field("hash", row.meta.contentHash.slice(0, 16) + "\u2026")}
      {row.meta.origin === "vendor" && row.meta.vendoredAt ? field("vendored", formatUtc(row.meta.vendoredAt).slice(0, 10)) : null}
      {links.length > 0 ? (
        <box flexDirection="column" paddingTop={1}>
          <TextLine fg={colors.muted}>{"project links:"}</TextLine>
          {links.map((l) => (
            <TextLine key={l.project}>
              <span fg={colors.text}>{`  ${l.project}`}</span>
              <span fg={colors.muted}>{` (${l.mode})`}</span>
            </TextLine>
          ))}
        </box>
      ) : null}
      <TextLine fg={colors.muted}>{"esc to close"}</TextLine>
    </Modal>
  );
}
