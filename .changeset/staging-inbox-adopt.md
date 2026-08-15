---
"@gcavanunez/slinky": minor
---

Consolidate skills through a staging inbox instead of driving skills.sh non-interactively.

`slinky skills add <source>` now runs `npx skills add` project-scoped inside the host repo (`--project -a universal`), so omitting `--skill` hands you skills.sh's own picker rather than a reimplementation of it, and `--skill` may be repeated. Installing project-scoped also stops skills.sh reporting failures for agents that do not support global installs.

skills.sh writes into `<repo>/.agents/skills/`, which Slinky now treats as a staging inbox: `slinky adopt` lists staged skills alongside host skills missing from the manifest, reads provenance from `<repo>/skills-lock.json`, and recovers the git tree hash from GitHub that project-scoped locks omit so `update --check` keeps working. Adoption clears the staging directory, removes the `.claude` symlink pointing at it, and prunes the adopted lock entry; a staged copy identical to an indexed baseline is discarded as redundant, and agent directories populated by a hand-run `npx skills add` are reported rather than deleted.

This means you can run `npx skills add <source>` in the host repo yourself and let `slinky adopt` vendor the result.

Removes the `--list` flag and the ANSI-scraping skill listing added for it, which are no longer needed now that skills.sh does its own discovery.
