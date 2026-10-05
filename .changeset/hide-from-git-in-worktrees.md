---
"@gcavanunez/slinky": patch
---

"Hide from git" now works when the project is a linked Git worktree. Slinky used to skip it silently there because `.git` is a file, so the linked skill showed up in `git status`. The exclude lines now go to the main checkout's `.git/info/exclude`, the file Git actually reads for every worktree. Since that file is shared, unlinking a skill from one worktree keeps its line while another worktree's link still uses it. Links made in a worktree before this fix are still recorded as tracked; unlink and link them again to hide them.
