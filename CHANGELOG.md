# @gcavanunez/slinky

## 0.2.0

### Minor Changes

- 737c34c: Add `slinky restore all` to reset every drifting live vendor skill from the catalog baseline, and add positional `slinky adopt all` as an equivalent to `slinky adopt --all` for importing every unindexed global or staged skill.
- f9170bd: Record a preferred diff pager and review updates in one session. `slinky config diff-pager <hunk|delta|none>` persists the choice in `~/.config/slinky/config.json`, and `slinky config` shows the recorded host and pager. Both `slinky diff` and `slinky update` use it, with the existing `--hunk`/`--delta`/`--pager` flags overriding it for one run and a new `--no-pager` forcing inline output.

  `slinky update` now collects every changed skill into a single aggregate patch and opens that one pager session before prompting, instead of dumping each unified diff into the terminal where it could not be read. Writing one config field no longer drops another, so setting a pager survives a later `slinky init`.

- 8c85ed3: Resolve the TUI editor instead of hardcoding `nvim`. Pressing `e` previously always spawned `nvim`, with no `$EDITOR` or `$VISUAL` lookup anywhere. The editor now resolves in order: `editor` from `~/.config/slinky/config.json`, then `$VISUAL`, then `$EDITOR`, then `nvim`. Set it with `slinky config editor "code -w"`, or `none` to fall back to the environment.

  The spec may carry flags and is tokenised with single and double quotes respected, so an editor at a path containing spaces works. The resulting argv is spawned directly rather than through a shell, so a skill path can never be interpreted as shell syntax. The TUI's help text and failure notice now name the resolved editor rather than saying `nvim`.

- 09d0bf6: Add Hunk and Delta integrations to `slinky diff` through direct flags, a generic pager option, and the TUI drift review. The TUI can also accept a live global skill as the repository baseline or restore the global skill from that baseline, and author groups now flag contained drift.
- 4877ba1: Commit vendor update provenance in the skills host, absorb it during staged and global adoption, and seed the machine skills.sh lock before updates so shared catalogs use consistent upstream sources across machines.
- 7d58707: Make `slinky pull` replay diverged local commits onto the upstream tip instead of refusing. Running `slinky save` on two machines is the ordinary way this catalog diverges, and those commits almost always touch disjoint skills, so pull now rebases them itself. It only does so when it can prove the outcome first: `git merge-tree` has to merge both sides without conflict, and the merged catalog must not retire a skill, because retirement needs the preflight the fast-forward path runs. Conflicts and retirements are still reported — now naming the conflicting paths or the retired skills — and a replay that cannot be completed is aborted so the branch is left where it was found.
- 57631f4: Stop making a stale local hash block `slinky save`. Local skills are symlinked into the global store, so editing the installed copy edits the repo copy directly and leaves the manifest hash behind; `save` already committed that content, so the mismatch was bookkeeping rather than a reason to abort. `slinky save` now refreshes stale local hashes itself and prints each skill it touched, and `slinky rehash` with no arguments sweeps every stale local skill. Vendor skills are still excluded: a hash mismatch on a committed baseline means it was hand-edited instead of going through `slinky vendor`, and that remains a verification failure.
- 35cf614: Add safe `push`, fast-forward-only `pull`, and `sync --pull` workflows for sharing a catalog across machines while preserving each machine's local state. Add `slinky version` as a discoverable equivalent to `slinky --version`.
- 0c5f0ff: Add `slinky save` to verify and commit catalog-managed paths in the skills host without including unrelated staged files.
- 5318287: Add `slinky skills add` for lock-aware skills.sh installation, surface host skill directories that are not indexed in the manifest, let users index matching skills from the TUI, show project placement and Git visibility on skill rows, and provide top-level `available here` and `all skills` catalog tabs.
- 7586d61: Consolidate skills through a staging inbox instead of driving skills.sh non-interactively.

  `slinky skills add <source>` now runs `npx skills add` project-scoped inside the host repo (`--project -a universal`), so omitting `--skill` hands you skills.sh's own picker rather than a reimplementation of it, and `--skill` may be repeated. Installing project-scoped also stops skills.sh reporting failures for agents that do not support global installs.

  skills.sh writes into `<repo>/.agents/skills/`, which Slinky now treats as a staging inbox: `slinky adopt` lists staged skills alongside host skills missing from the manifest, reads provenance from `<repo>/skills-lock.json`, and recovers the git tree hash from GitHub that project-scoped locks omit so `update --check` keeps working. Adoption clears the staging directory, removes the `.claude` symlink pointing at it, and prunes the adopted lock entry; a staged copy identical to an indexed baseline is discarded as redundant, and agent directories populated by a hand-run `npx skills add` are reported rather than deleted.

  This means you can run `npx skills add <source>` in the host repo yourself and let `slinky adopt` vendor the result.

  Removes the `--list` flag and the ANSI-scraping skill listing added for it, which are no longer needed now that skills.sh does its own discovery.

- 570ba30: Notice unpulled catalog commits: `slinky update` refuses to run on a store behind its upstream (`--force` overrides) and `update --check` reports it; the TUI checks in the background on launch, shows `⇣ N to pull`, and `S` runs `slinky sync` in a scrollable modal.
- 285d3e8: Copy TUI text selections on mouse release or Ctrl-C through OSC52 and native clipboard utilities.
- 570ba30: Redesign the TUI: open panes divided by rails with a single foldable catalog tree (headings toggle, fold, and summarise their group), labelled status columns, persistent document zoom, `f` to reveal `SKILL.md` frontmatter, and 27 colour themes chosen with `t` or `slinky config theme`.
- 9d467d2: Add `x` to zoom the focused TUI pane, `v`/`V` to cycle the split, catalog-only, and document-only layouts, `<`/`>` to resize the split, and an `e` editor action for local skills in the skills host.
- 5318287: Extend TUI navigation: full-page (`ctrl-f`/`ctrl-b`) and line-wise (`ctrl-e`/`ctrl-y`) scrolling, in-document search from the document pane (`/` with `n`/`N` match jumping), markdown heading jumps (`{`/`}`), and mouse support — click rows, panels, and catalog tabs; wheel-scroll lists and the file tree.

### Patch Changes

- d9e4116: Stop treating `$HOME` as a project. Its `.agents/skills` and `.claude/skills` are the global stores, so opening the TUI from the home directory reported every installed skill as an `unmanaged` project skill. Linking is now refused there as well: the guard that already blocked linking into the skills repo has moved into `linkSkill`, where it covers the TUI as well as the CLI, and it now also rejects any directory whose `.agents/skills` resolves to the global store.
- fc89a81: Upgrade to Effect 4.0.0-rc.112 and TypeScript 7.0.2, consolidate Effect imports through the package root, and remove the unused Effect Node platform dependency.
- 7586d61: Fix the TUI failing to start from a project that sets its own `jsxImportSource`. Bun resolves `tsconfig.json` from the current working directory rather than from the source file, so running `slinky` inside (for example) a Vue project transformed the TUI's JSX against that project's runtime and failed with `Cannot find module 'vue/jsx-dev-runtime'`. The TUI's `.tsx` files now pin `@jsxImportSource @opentui/react` per file.
- 8193f73: Publish standalone macOS and Linux binaries for ARM64 and x64. The main npm package now selects the matching platform package and no longer requires Bun at runtime.
- b57ce7d: Ignore machine-local disabled-skill tombstones after a catalog removes or renames a skill, while continuing to reject stale project links that require explicit cleanup.
- 5e38d83: Allow `slinky save` to stage tracked catalog paths removed or renamed by a catalog migration.
- d582df5: Route CLI and TUI catalog behavior through shared application operations. Adoption now compensates manifest, state, lock, and filesystem changes as one transaction; save, pull, push, and sync own their Git lifecycle outside the CLI adapter; and catalog inspection consistently rejects wrong-target links. Machine state migrates to a version-2 custom/profile selection that derives profile membership without caching duplicate disabled-skill state.
- f282797: Consolidate catalog mutations into shared application workflows used by both the CLI and TUI. `enable`, `disable`, and `profile apply` with `--dry-run` no longer persist state; previews leave `.local/state.json` and the global stores untouched. Project-link timestamps are now constructed through the canonical encoded form, and immutable aggregate transitions validate decoded values correctly.
