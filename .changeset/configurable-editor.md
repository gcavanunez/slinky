---
"@gcavanunez/slinky": minor
---

Resolve the TUI editor instead of hardcoding `nvim`. Pressing `e` previously always spawned `nvim`, with no `$EDITOR` or `$VISUAL` lookup anywhere. The editor now resolves in order: `editor` from `~/.config/slinky/config.json`, then `$VISUAL`, then `$EDITOR`, then `nvim`. Set it with `slinky config editor "code -w"`, or `none` to fall back to the environment.

The spec may carry flags and is tokenised with single and double quotes respected, so an editor at a path containing spaces works. The resulting argv is spawned directly rather than through a shell, so a skill path can never be interpreted as shell syntax. The TUI's help text and failure notice now name the resolved editor rather than saying `nvim`.
