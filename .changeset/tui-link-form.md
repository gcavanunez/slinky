---
"@gcavanunez/slinky": minor
---

`L` in the TUI now opens a single form instead of a three-step wizard. Pick the target, either this project (the git repository around the working directory) or global (turn the skill on in the global stores), then for a project choose copy or symlink and the `[x]` options for hiding it from Git and adding the `.claude/skills` symlink. `tab` or the arrow keys move between rows, skipping ones that do not apply, `space` chooses or toggles, `enter` links, and a failed link keeps the form open with its error.
