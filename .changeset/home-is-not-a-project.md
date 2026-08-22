---
"@gcavanunez/slinky": patch
---

Stop treating `$HOME` as a project. Its `.agents/skills` and `.claude/skills` are the global stores, so opening the TUI from the home directory reported every installed skill as an `unmanaged` project skill. Linking is now refused there as well: the guard that already blocked linking into the skills repo has moved into `linkSkill`, where it covers the TUI as well as the CLI, and it now also rejects any directory whose `.agents/skills` resolves to the global store.
