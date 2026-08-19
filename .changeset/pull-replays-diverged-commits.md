---
"@gcavanunez/slinky": minor
---

Make `slinky pull` replay diverged local commits onto the upstream tip instead of refusing. Running `slinky save` on two machines is the ordinary way this catalog diverges, and those commits almost always touch disjoint skills, so pull now rebases them itself. It only does so when it can prove the outcome first: `git merge-tree` has to merge both sides without conflict, and the merged catalog must not retire a skill, because retirement needs the preflight the fast-forward path runs. Conflicts and retirements are still reported — now naming the conflicting paths or the retired skills — and a replay that cannot be completed is aborted so the branch is left where it was found.
