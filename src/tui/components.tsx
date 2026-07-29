import type { ReactNode } from "react";
import { colors } from "./theme.ts";

/** One terminal row: no wrapping, truncated, bg fills the line. */
export function TextLine(props: { fg?: string; bg?: string; children?: ReactNode }) {
  return (
    <box height={1}>
      <text wrapMode="none" truncate fg={props.fg ?? colors.text} bg={props.bg}>
        {props.children}
      </text>
    </box>
  );
}

/** Centered overlay panel. */
export function Modal(props: { title: string; width: number; cols: number; top?: number; children?: ReactNode }) {
  const width = Math.min(props.width, props.cols - 4);
  const left = Math.max(0, Math.floor((props.cols - width) / 2));
  return (
    <box
      position="absolute"
      left={left}
      top={props.top ?? 2}
      width={width}
      border
      borderStyle="single"
      borderColor={colors.modalBorder}
      backgroundColor={colors.headerBg}
      title={` ${props.title} `}
      paddingLeft={1}
      paddingRight={1}
      zIndex={10}
    >
      {props.children}
    </box>
  );
}

export function Hint(props: { keys: string; label: string }) {
  return (
    <span>
      <span fg={colors.accent}>{props.keys}</span>
      <span fg={colors.muted}>{` ${props.label}  `}</span>
    </span>
  );
}
