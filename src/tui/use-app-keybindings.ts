import { useRef } from "react";
import type { KeyEvent } from "@opentui/core";
import { useBindings } from "@opentui/keymap/react";
import { useKeyboard } from "@opentui/react";

export type AppCommand =
  | "app.copy-or-quit"
  | "app.quit"
  | "overlay.close"
  | "diff.accept"
  | "diff.restore"
  | "diff.hunk"
  | "diff.delta"
  | "profiles.next"
  | "profiles.previous"
  | "profiles.apply"
  | "view.available"
  | "view.all"
  | "panel.next-wrap"
  | "panel.next"
  | "panel.previous"
  | "panel.first"
  | "panel.last"
  | "layout.zoom"
  | "layout.next"
  | "layout.previous"
  | "layout.shrink"
  | "layout.grow"
  | "catalog.fold"
  | "catalog.fold-all"
  | "app.escape"
  | "document.next-heading"
  | "document.previous-heading"
  | "document.next-file"
  | "document.previous-file"
  | "document.frontmatter"
  | "document.scroll-three-down"
  | "document.scroll-three-up"
  | "document.page-down"
  | "document.page-up"
  | "document.scroll-line-down"
  | "document.scroll-line-up"
  | "selection.next"
  | "selection.previous"
  | "selection.half-page-down"
  | "selection.half-page-up"
  | "selection.page-down"
  | "selection.page-up"
  | "selection.first"
  | "selection.last"
  | "search.open"
  | "search.next"
  | "search.previous"
  | "catalog.refresh"
  | "skill.edit"
  | "help.open"
  | "help.close"
  | "upstream.check"
  | "profiles.open"
  | "theme.open"
  | "store.sync"
  | "selection.open"
  | "selection.toggle"
  | "skill.details"
  | "skill.index"
  | "skill.diff"
  | "skill.link";

export interface AppKeymapState {
  readonly listActive: boolean;
  readonly overlayActive: boolean;
  readonly diffActive: boolean;
  readonly profilesActive: boolean;
  readonly helpActive: boolean;
  readonly textInputActive: boolean;
}

interface CommandDefinition {
  readonly name: AppCommand;
  readonly title: string;
  readonly keys: ReadonlyArray<string | { readonly name: string; readonly shift?: boolean }>;
}

const listCommands: ReadonlyArray<CommandDefinition> = [
  { name: "app.quit", title: "Quit", keys: ["q"] },
  { name: "view.available", title: "Show skills available here", keys: ["1"] },
  { name: "view.all", title: "Show all skills", keys: ["2"] },
  { name: "panel.next-wrap", title: "Focus next panel, wrapping", keys: ["tab"] },
  { name: "panel.next", title: "Focus next panel", keys: ["right", "l"] },
  { name: "panel.previous", title: "Focus previous panel", keys: ["left", "h"] },
  { name: "panel.first", title: "Focus first panel", keys: ["0"] },
  { name: "panel.last", title: "Focus last panel", keys: ["$", { name: "4", shift: true }] },
  { name: "layout.zoom", title: "Expand or restore panel", keys: ["x"] },
  { name: "layout.next", title: "Next layout", keys: ["v"] },
  { name: "layout.previous", title: "Previous layout", keys: ["shift+v"] },
  { name: "layout.shrink", title: "Shrink focused pane", keys: ["<", "shift+,"] },
  { name: "layout.grow", title: "Grow focused pane", keys: [">", "shift+."] },
  { name: "catalog.fold", title: "Fold or unfold the current group", keys: ["z"] },
  { name: "catalog.fold-all", title: "Fold or unfold every group", keys: ["shift+z"] },
  { name: "app.escape", title: "Leave the current view", keys: ["escape"] },
  { name: "document.next-heading", title: "Next document heading", keys: ["}", "shift+]"] },
  { name: "document.previous-heading", title: "Previous document heading", keys: ["{", "shift+["] },
  { name: "document.next-file", title: "Next related file", keys: ["]"] },
  { name: "document.previous-file", title: "Previous related file", keys: ["["] },
  { name: "document.frontmatter", title: "Show or hide SKILL.md frontmatter", keys: ["f"] },
  { name: "document.scroll-three-down", title: "Scroll document down", keys: ["shift+j"] },
  { name: "document.scroll-three-up", title: "Scroll document up", keys: ["shift+k"] },
  { name: "document.page-down", title: "Scroll document one page down", keys: ["pagedown"] },
  { name: "document.page-up", title: "Scroll document one page up", keys: ["pageup"] },
  { name: "document.scroll-line-down", title: "Scroll document one line down", keys: ["ctrl+e"] },
  { name: "document.scroll-line-up", title: "Scroll document one line up", keys: ["ctrl+y"] },
  { name: "selection.next", title: "Move down", keys: ["j", "down"] },
  { name: "selection.previous", title: "Move up", keys: ["k", "up"] },
  { name: "selection.half-page-down", title: "Move half a page down", keys: ["ctrl+d"] },
  { name: "selection.half-page-up", title: "Move half a page up", keys: ["ctrl+u"] },
  { name: "selection.page-down", title: "Move one page down", keys: ["ctrl+f"] },
  { name: "selection.page-up", title: "Move one page up", keys: ["ctrl+b"] },
  { name: "selection.last", title: "Move to last item", keys: ["shift+g"] },
  { name: "search.open", title: "Filter or search", keys: ["/"] },
  { name: "search.next", title: "Next search match", keys: ["n"] },
  { name: "search.previous", title: "Previous search match", keys: ["shift+n"] },
  { name: "catalog.refresh", title: "Reload catalog", keys: ["r"] },
  { name: "skill.edit", title: "Edit selected skill", keys: ["e"] },
  { name: "help.open", title: "Open help", keys: ["?"] },
  { name: "upstream.check", title: "Check upstream", keys: ["u"] },
  { name: "profiles.open", title: "Open profiles", keys: ["p"] },
  { name: "theme.open", title: "Open theme picker", keys: ["t"] },
  { name: "store.sync", title: "Sync the catalog store", keys: ["shift+s"] },
  { name: "selection.open", title: "Open selection", keys: ["return", "enter"] },
  { name: "selection.toggle", title: "Toggle selection", keys: ["space"] },
  { name: "skill.details", title: "Show skill details", keys: ["i"] },
  { name: "skill.index", title: "Index selected skill", keys: ["a"] },
  { name: "skill.diff", title: "Diff selected skill", keys: ["d"] },
  { name: "skill.link", title: "Link selected skill", keys: ["shift+l"] },
];

const overlayCommands: ReadonlyArray<CommandDefinition> = [{ name: "overlay.close", title: "Close overlay", keys: ["escape", "q"] }];

const diffCommands: ReadonlyArray<CommandDefinition> = [
  { name: "diff.accept", title: "Accept live copy as baseline", keys: ["a"] },
  { name: "diff.restore", title: "Restore repository baseline", keys: ["r"] },
  { name: "diff.hunk", title: "Open diff in Hunk", keys: ["h"] },
  { name: "diff.delta", title: "Open diff in Delta", keys: ["d"] },
];

const profileCommands: ReadonlyArray<CommandDefinition> = [
  { name: "profiles.next", title: "Select next profile", keys: ["j", "down"] },
  { name: "profiles.previous", title: "Select previous profile", keys: ["k", "up"] },
  { name: "profiles.apply", title: "Apply selected profile", keys: ["return", "enter"] },
];

function layer(definitions: ReadonlyArray<CommandDefinition>, run: (command: AppCommand, event: KeyEvent) => void) {
  return {
    commands: definitions.map((definition) => ({
      name: definition.name,
      title: definition.title,
      run: ({ event }: { event: KeyEvent }) => run(definition.name, event),
    })),
    bindings: definitions.flatMap((definition) => definition.keys.map((key) => ({ key, cmd: definition.name }))),
  };
}

export function useAppKeybindings(state: AppKeymapState, run: (command: AppCommand, event: KeyEvent) => void): void {
  const runRef = useRef(run);
  const pendingG = useRef(0);
  runRef.current = run;
  const dispatch = (command: AppCommand, event: KeyEvent) => runRef.current(command, event);

  // A lone g is intentionally a no-op. Keeping this tiny sequence outside the keymap
  // lets unrelated keys continue through immediately instead of being swallowed as mismatches.
  useKeyboard((event) => {
    if (!state.listActive || event.name !== "g" || event.ctrl || event.meta || event.shift) return;
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - pendingG.current <= 500) {
      pendingG.current = 0;
      dispatch("selection.first", event);
    } else pendingG.current = now;
  });

  useBindings(
    () => ({
      ...layer([{ name: "app.copy-or-quit", title: "Copy selection or quit", keys: ["ctrl+c"] }], dispatch),
      enabled: !state.textInputActive,
    }),
    [state.textInputActive],
  );
  useBindings(() => ({ ...layer(overlayCommands, dispatch), enabled: state.overlayActive }), [state.overlayActive]);
  useBindings(() => ({ ...layer(diffCommands, dispatch), enabled: state.diffActive }), [state.diffActive]);
  useBindings(() => ({ ...layer(profileCommands, dispatch), enabled: state.profilesActive }), [state.profilesActive]);
  useBindings(
    () => ({
      ...layer([{ name: "help.close", title: "Close help", keys: ["?"] }], dispatch),
      enabled: state.helpActive,
      priority: 1,
    }),
    [state.helpActive],
  );
  useBindings(() => ({ ...layer(listCommands, dispatch), enabled: state.listActive }), [state.listActive]);
}
