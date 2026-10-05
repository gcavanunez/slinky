---
"@gcavanunez/slinky": patch
---

Linking a skill into a project no longer fails with "already linked (unlink first)" when the recorded link's files are gone, such as after deleting `.agents/skills/<name>` by hand or recreating a removed worktree at the same path. The stale record is replaced, its dangling `.claude/skills` symlink and `.git/info/exclude` lines are cleaned up, and the skill is linked fresh.
