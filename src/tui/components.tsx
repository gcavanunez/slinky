/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { MouseEvent } from "@opentui/core";
import { colors } from "./theme.ts";
import { fitCell } from "./util.ts";

/** One terminal row: no wrapping, truncated, bg fills the line. */
export function TextLine(props: { fg?: string; bg?: string; width?: number; onMouseDown?: (event: MouseEvent) => void; children?: ReactNode }) {
  return (
    <box height={1} width={props.width} onMouseDown={props.onMouseDown}>
      <text wrapMode="none" truncate fg={props.fg ?? colors.text} bg={props.bg}>
        {props.children}
      </text>
    </box>
  );
}

/** One row of a single colour. */
export function PlainLine(props: { text: string; fg?: string; bold?: boolean }) {
  return (
    <box height={1}>
      <text wrapMode="none" truncate fg={props.fg ?? colors.text} attributes={props.bold ? TextAttributes.BOLD : 0}>
        {props.text}
      </text>
    </box>
  );
}

export interface Junction {
  readonly at: number;
  readonly char: string;
}

/** Horizontal rail. Junction columns swap `─` for `┬`, `┴`, `┼`, etc. */
export function Divider(props: { width: number; junctions?: ReadonlyArray<Junction> }) {
  const width = Math.max(1, props.width);
  const chars = new Map((props.junctions ?? []).filter((j) => j.at >= 0 && j.at < width).map((j) => [j.at, j.char] as const));
  const text = chars.size === 0 ? "─".repeat(width) : Array.from({ length: width }, (_, index) => chars.get(index) ?? "─").join("");
  return <PlainLine text={text} fg={colors.separator} />;
}

/** Vertical rail between panes. Junction rows swap `│` for `├`, `┤`, etc. */
export function SeparatorColumn(props: { height: number; junctions?: ReadonlyArray<{ readonly row: number; readonly char: string }> }) {
  const chars = new Map((props.junctions ?? []).map((j) => [j.row, j.char] as const));
  return (
    <box width={1} height={props.height} flexDirection="column">
      {Array.from({ length: Math.max(0, props.height) }, (_, index) => (
        <PlainLine key={index} text={chars.get(index) ?? "│"} fg={colors.separator} />
      ))}
    </box>
  );
}

/**
 * Uppercase pane heading; accent+bold when the pane has focus. `columns` is a
 * right-aligned column header, laid out to end at `width` like the rows beneath;
 * the detail gives way to it when both cannot fit.
 */
export function PaneTitle(props: { title: string; detail?: string; columns?: string; focused: boolean; width?: number; onMouseDown?: (event: MouseEvent) => void }) {
  const title = props.title.toUpperCase();
  let detail = props.detail;
  let gap = "";
  if (props.columns && props.width) {
    const leftLen = 1 + title.length + (detail ? 1 + detail.length : 0);
    let pad = props.width - leftLen - props.columns.length;
    if (pad < 1 && detail) {
      detail = undefined;
      pad = props.width - 1 - title.length - props.columns.length;
    }
    gap = " ".repeat(Math.max(1, pad));
  }
  return (
    <TextLine width={props.width} onMouseDown={props.onMouseDown}>
      <span> </span>
      <span fg={props.focused ? colors.accent : colors.muted} attributes={TextAttributes.BOLD}>
        {title}
      </span>
      {detail ? <span fg={props.focused ? colors.count : colors.separator}>{` ${detail}`}</span> : null}
      {props.columns ? <span fg={props.focused ? colors.muted : colors.separator}>{`${gap}${props.columns}`}</span> : null}
    </TextLine>
  );
}

export interface HintItem {
  readonly key: string;
  readonly label: string;
  /** Omit the hint entirely when false. */
  readonly when?: boolean;
  /** Keep the hint visible but render it in the rail colour. */
  readonly disabled?: boolean;
}

/** `key label  key label` with keys in `count` and labels muted. */
export function HintRow(props: { items: ReadonlyArray<HintItem>; leading?: string }) {
  const visible = props.items.filter((item) => item.when !== false);
  return (
    <TextLine>
      {props.leading ? <span>{props.leading}</span> : null}
      {visible.flatMap((item, index) => {
        const keyFg = item.disabled ? colors.separator : colors.count;
        const labelFg = item.disabled ? colors.separator : colors.muted;
        return [
          <span key={`k${index}`} fg={keyFg}>
            {item.key}
          </span>,
          <span key={`l${index}`} fg={labelFg}>{` ${item.label}${index < visible.length - 1 ? "  " : ""}`}</span>,
        ];
      })}
    </TextLine>
  );
}

/** Empty rows, used to centre a message inside a fixed-height region. */
export function Filler(props: { rows: number }) {
  return (
    <>
      {Array.from({ length: Math.max(0, props.rows) }, (_, index) => (
        <box key={index} height={1} />
      ))}
    </>
  );
}

/** Hand-drawn frame: `┌─┐` / `│ │` / `└─┘`, with `├ ┤` on the given inner rows. */
export function ModalFrame(props: { left: number; top: number; width: number; height: number; junctionRows?: ReadonlyArray<number>; children?: ReactNode }) {
  const innerWidth = Math.max(1, props.width - 2);
  const innerHeight = Math.max(1, props.height - 2);
  const junctions = new Set(props.junctionRows ?? []);
  const rail = (char: string, junction: string) =>
    Array.from({ length: innerHeight }, (_, index) => <PlainLine key={index} text={junctions.has(index) ? junction : char} fg={colors.separator} />);
  return (
    <box
      position="absolute"
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      flexDirection="column"
      backgroundColor={colors.modalBackground}
      zIndex={10}
    >
      <PlainLine text={`┌${"─".repeat(innerWidth)}┐`} fg={colors.separator} />
      <box height={innerHeight} flexDirection="row">
        <box width={1} height={innerHeight} flexDirection="column">
          {rail("│", "├")}
        </box>
        <box width={innerWidth} height={innerHeight} flexDirection="column">
          {props.children}
        </box>
        <box width={1} height={innerHeight} flexDirection="column">
          {rail("│", "┤")}
        </box>
      </box>
      <PlainLine text={`└${"─".repeat(innerWidth)}┘`} fg={colors.separator} />
    </box>
  );
}

export interface ModalProps {
  title: string;
  titleFg?: string;
  /** Right-aligned text on the title row, e.g. a position counter. */
  headerRight?: string;
  /** Optional second header row, above the first divider. */
  subtitle?: ReactNode;
  width: number;
  cols: number;
  rows: number;
  /** Rows the body needs; the frame clamps to what fits on screen. */
  bodyRows: number;
  footer: ReadonlyArray<HintItem>;
  children?: ReactNode;
}

/** Widths available inside a Modal of the given outer width. */
export function modalInner(width: number, cols: number) {
  const outer = Math.max(20, Math.min(width, cols - 4));
  return { width: outer, innerWidth: outer - 2, contentWidth: outer - 4 };
}

/**
 * Centred overlay: title row, optional subtitle, divider, body, divider, footer.
 * Body height is content-driven (bodyRows) but never taller than the screen allows.
 */
export function Modal(props: ModalProps) {
  const { width, innerWidth, contentWidth } = modalInner(props.width, props.cols);
  const hasSubtitle = props.subtitle !== undefined && props.subtitle !== null;
  const chromeRows = 6 + (hasSubtitle ? 1 : 0);
  const bodyRows = Math.max(1, Math.min(props.bodyRows, props.rows - 2 - chromeRows));
  const height = bodyRows + chromeRows;
  const left = Math.max(0, Math.floor((props.cols - width) / 2));
  const top = Math.max(0, Math.floor((props.rows - height) / 2));
  const dividerAfterHeader = hasSubtitle ? 2 : 1;
  const right = props.headerRight ?? "";
  const gap = Math.max(1, contentWidth - props.title.length - right.length);
  return (
    <ModalFrame left={left} top={top} width={width} height={height} junctionRows={[dividerAfterHeader, height - 4]}>
      <box height={1} paddingLeft={1} paddingRight={1}>
        <TextLine>
          <span fg={props.titleFg ?? colors.accent} attributes={TextAttributes.BOLD}>
            {props.title}
          </span>
          {right ? (
            <>
              <span>{" ".repeat(gap)}</span>
              <span fg={colors.muted}>{right}</span>
            </>
          ) : null}
        </TextLine>
      </box>
      {hasSubtitle ? (
        <box height={1} paddingLeft={1} paddingRight={1}>
          {props.subtitle}
        </box>
      ) : null}
      <Divider width={innerWidth} />
      <box height={bodyRows} flexDirection="column" paddingLeft={1} paddingRight={1} overflow="hidden">
        {props.children}
      </box>
      <Divider width={innerWidth} />
      <box height={1} paddingLeft={1} paddingRight={1}>
        <HintRow items={props.footer} />
      </box>
    </ModalFrame>
  );
}

/** Label/value row for detail-style modals. */
export function Field(props: { label: string; value: string; fg?: string; labelWidth?: number }) {
  return (
    <TextLine>
      <span fg={colors.muted}>{fitCell(props.label, props.labelWidth ?? 12)}</span>
      <span fg={props.fg ?? colors.text}>{props.value}</span>
    </TextLine>
  );
}
