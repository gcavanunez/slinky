# Slinky guide

The long-form reference. The [README](../README.md) covers install and everyday use; this page covers how each workflow behaves and where its edges are. Formats are in [data-contract.md](data-contract.md).

## Contents

- [Catalog model](#catalog-model)
- [Bootstrap](#bootstrap)
- [The TUI](#the-tui)
- [Sync, save, push, pull](#sync-save-push-pull)
- [Adding and adopting skills](#adding-and-adopting-skills)
- [Updating vendor skills](#updating-vendor-skills)
- [Project links](#project-links)
- [Configuration](#configuration)
- [Safety](#safety)
- [Host discovery](#host-discovery)
- [CLI reference](#cli-reference)

## Catalog model

- **Local skills** live under `skills/` and are symlinked into the canonical global store.
- **Vendor skills** live under `vendor/` as committed baselines and are copied into the global store so `npx skills` can update them.
- **Profiles** define exact enabled sets.
- **Machine state** records disabled skills, the active profile, and project links in `.local/state.json`.
- **Project links** copy or symlink a catalog skill into another repository.

The application and catalog stay separate: Slinky owns the tooling, while the host repository owns `skills/`, `vendor/`, `commands/`, and `skills.manifest.json`.

Keep `.local/` ignored because state contains machine-specific preferences and absolute project paths. The committed `.skill-lock.json` contains only vendor update provenance; Slinky merges it into each machine's skills.sh lock without replacing unrelated global skills or preferences.

After editing locally authored skill content, refresh its manifest hash and verify the catalog:

```bash
slinky rehash my-skill   # or bare `slinky rehash` for every stale local skill
slinky verify
```

`slinky save` refreshes stale local hashes itself and prints each one it touched, so editing a local skill and saving is a single step. Vendor skills are never rehashed: a mismatch there means the committed baseline was hand-edited instead of going through `slinky vendor`, and that still fails verification.

## Bootstrap

Point Slinky at an existing skills host:

```bash
slinky init /path/to/my-agent-skills
slinky bootstrap --dry-run
slinky bootstrap
```

`bootstrap` backs up existing global skill directories, reports skills the host does not know about, materializes enabled skills, and verifies the catalog. Use `--adopt-all` only when every reported foreign skill should be imported. Backups are written under `~/.local/state/my-agent-skills-backups`; inspect an archive before manually restoring it into `$HOME`.

To start with an empty host, create the versioned catalog first:

```bash
mkdir -p ~/my-agent-skills/skills ~/my-agent-skills/vendor
cat > ~/my-agent-skills/skills.manifest.json <<'JSON'
{
  "version": 1,
  "skills": {},
  "profiles": {}
}
JSON
printf '{"version":3,"skills":{}}\n' > ~/my-agent-skills/.skill-lock.json
printf '.local/\n' > ~/my-agent-skills/.gitignore
git -C ~/my-agent-skills init
git -C ~/my-agent-skills add skills.manifest.json .skill-lock.json .gitignore
git -C ~/my-agent-skills commit -m "Initialize skills catalog"
slinky init ~/my-agent-skills
```

Existing global skills can then be imported with `slinky adopt` or `slinky adopt <name> --local`.

For a fresh machine, clone and initialize a host in one step:

```bash
slinky bootstrap --clone=https://github.com/you/my-agent-skills.git
```

The clone form requires an existing remote host. Even with `--dry-run`, it still clones the repository and records its location; dry-run applies to reconciliation after setup.

## The TUI

`slinky` with no arguments opens the terminal UI, arranged as `catalog | document` with a related-file tree on the document's right edge.

### Catalog

The catalog is one tree: a heading per author (or `local`, `unindexed`, `project only`) with its skills beneath. Headings are selectable and carry the group's enabled count and a yellow `⚠` when any visible skill has confirmed drift.

| key | on a heading | on a skill |
|---|---|---|
| `space` | toggle every skill in the group | toggle the skill |
| `z` / `enter` | fold or unfold | — / enter the document pane |
| `Z` | fold or unfold every group | same |
| `h` | fold | jump to its heading |
| `l` | unfold, else next pane | next pane |
| `i` | summarise the group | details |

Filtering with `/` shows every matching group open and hides the rest; the fold state returns when the filter clears. `1` shows only skills discoverable globally or through the current project's `.agents` and `.claude` directories; `2` shows the complete catalog.

Status columns are `on` (enabled), `live` (global store state), `project` (placement in the current project), and `up` (upstream: `^` update available, `×` gone, `=` current). Placement values `link·hid` and `copy·hid` are excluded through `.git/info/exclude`; `link·git` and `copy·git` are visible to Git.

### Layout

`h/l` and the arrow keys move between panes; `tab` wraps. `x` zooms the focused pane and persists while you move between the document and its file tree. `v`/`V` cycle split, catalog only, and document only; `<`/`>` resize the split. Below 84 columns only the focused pane is shown.

### Document

`j/k` scroll, `{`/`}` jump between Markdown headings, `[`/`]` move between related files, `/` searches the document with `n`/`N` for matches. `SKILL.md` frontmatter is hidden from the rendered document; `f` shows it as a yaml block.

### Actions

- `e` opens a local catalog skill or an unindexed local skill in your editor (the recorded `editor`, then `$VISUAL`, `$EDITOR`, then `nvim`) with the skills host as the working directory. Vendor baselines, the staging inbox, and project-only copies are excluded. The editor spec may carry flags and is tokenised with quotes respected, then spawned directly with no shell, so a skill path is never interpreted as shell syntax.
- `d` on a drifting vendor skill opens the drift review: `a` accepts the live global copy as the repository baseline, `r` restores the global copy from the baseline, `h` reviews in Hunk, `d` in Delta.
- `a` on an unindexed skill indexes it: enter the source (`kitlangton/skills`) or paste its add command. Slinky verifies that the installed content matches the unindexed copy before indexing it in place or moving it to the inferred vendor path.
- `L` links the skill into a project (copy or symlink). `p` applies a profile. `u` checks vendor skills upstream.
- `S` runs `slinky sync` in a modal showing its output. On launch the TUI fetches the store's tracking branch in the background; when commits are waiting, the tab row shows `⇣ N to pull · S sync`.
- `t` picks a colour theme: moving through the list previews it live, `enter` records it in `~/.config/slinky/config.json`, `esc` restores the saved one.
- Dragging across text copies it. `Ctrl-C` copies an active selection and otherwise quits. Clipboard writes use terminal OSC52 plus native platform utilities when available.
- `?` lists every binding.

## Sync, save, push, pull

`sync` is the complete convergence workflow: it saves reviewed catalog changes, pulls and rebases the configured upstream when present, reconciles global stores, and restores every live vendor copy to the resulting catalog baseline. Because that final step discards live vendor drift, run `slinky diff` or `slinky sync --dry-run` first when the drift has not already been reviewed. A host without Git or an upstream still runs the local reconcile and restore phases. `slinky sync --pull` remains accepted as a compatibility alias.

### Save

```bash
slinky save
slinky save --message "Add project skills"
```

`save` refuses unindexed directories under `skills/` or `vendor/`, verifies every manifest content hash and vendor lock entry, and commits only `.skill-lock.json`, `skills.manifest.json`, plus skill directories referenced by the current or committed manifest. Other staged files, including loose files elsewhere under `skills/` or `vendor/`, are left out of the commit. Vendored content is committed verbatim rather than subjected to the host repository's whitespace policy. The default commit message is `Update skills catalog`.

### Push and pull

`push` requires a clean worktree and verifies the catalog before running `git push` through the current branch's configured upstream.

`pull` also requires a clean worktree, fetches the configured upstream, and updates the branch by fast-forward. It refuses catalog removals that still have project links on the current machine.

Saving on two machines diverges the branch, so `pull` replays local commits onto the upstream tip rather than stopping. It only does so when it can prove the result first: the two sides must merge without conflict, and the merged catalog must not retire a skill. Anything else is reported with the conflicting paths or the retired skill names and left for you to resolve with `git rebase`. A replay that cannot be completed is aborted, leaving the branch where it was found.

Pulling preserves machine-local state: disabled skills, recent projects, project links, and an active profile that still exists upstream. Removed skills are dropped from local disabled state and removed profiles are deactivated. Standalone `pull` prunes retired global copies and machine provenance only when their content still matches the old committed baseline; drift requires review or an explicit `--force`. `sync` instead treats the command itself as authorization to discard vendor drift, including a drifting skill retired by the incoming catalog.

`slinky pull --dry-run` and `slinky sync --dry-run` do not fast-forward, commit, reconcile, or restore files. Sync dry-run fetches remote details when the catalog is already saved; when a save is pending, it reports that the pull preview follows the save.

## Adding and adopting skills

Add an upstream skill through Slinky so skills.sh provenance, the vendored baseline, and the manifest are updated together:

```bash
slinky skills add kitlangton/skills                        # skills.sh picks, Slinky vendors
slinky skills add kitlangton/skills --skill effect         # or name them
slinky skills add plannotator/effective-html --skill html --skill html-plan
```

Slinky does not implement skill discovery. It runs `npx skills add` **project-scoped inside the host repo**, so with no `--skill` you get skills.sh's own picker. skills.sh cannot be pointed at `vendor/<owner>/<name>`, its install directory is a fixed constant, so it installs into the repo's `.agents/skills/` staging inbox, and Slinky consolidates from there: vendor by owner, index in the manifest, reconcile, and clear the inbox.

### The staging inbox

`<repo>/.agents/skills/` is a handoff point, never a place to edit. Re-running `npx skills add` overwrites it without warning.

Because it is just a directory, you can fill it yourself and let Slinky consolidate later:

```bash
cd ~/my-agent-skills
npx skills add mattpocock/skills     # skills.sh installs into .agents/skills/
slinky adopt                         # review what is staged
slinky adopt all                     # vendor, index, and sync every candidate
```

`slinky adopt` lists staged skills alongside host skills that are missing from the manifest. `slinky adopt all` imports every candidate; `slinky adopt --all` remains an equivalent flag form. A staged copy wins its name when both exist. Staged adoption reads provenance from the temporary `<repo>/skills-lock.json`; global adoption reads the machine's skills.sh lock. Both absorb usable entries into the committed `<repo>/.skill-lock.json`. Since project-scoped locks omit the git tree hash, Slinky recovers it from GitHub so `slinky update --check` keeps working; an unreachable upstream just leaves the skill untracked.

The positional word `all` is reserved by `adopt` and `restore` for their bulk forms.

Afterwards Slinky clears the staging directory, removes the `.claude` symlink skills.sh left pointing at it, and prunes the adopted entry from `skills-lock.json`. A staged copy identical to a baseline already in the manifest is discarded as redundant. Running `npx skills add` yourself also copies into every agent directory it detects; Slinky reports those rather than deleting them, since they are in your worktree. Add `.agents/` to the host repo's `.gitignore` to keep the inbox out of git.

`slinky status` and the TUI also report skill directories under `skills/`, `vendor/`, or `.agents/skills/` that are missing from `skills.manifest.json`.

## Updating vendor skills

```bash
slinky update --check             # compare against upstream, change nothing
slinky update [skill...]          # fetch, review, decide per skill
```

Only vendor skills with persisted GitHub tree provenance can be checked. Well-known, unknown, private, rate-limited, or otherwise untracked sources appear as `unchecked`.

`slinky update` keeps the committed vendor baseline separate from the live copy updated by `npx skills`:

1. Fetch the store's tracking branch and refuse if commits are waiting to be pulled, so a vendor update never lands on a base a teammate has already moved past (`--force` overrides; an unreachable remote only warns). `update --check` reports the same comparison.
2. Require a clean `vendor/`, `skills/`, manifest, and `.skill-lock.json` baseline.
3. Seed selected entries in the machine's skills.sh lock from the committed host lock.
4. Run the upstream update against the live global store.
5. Open every changed skill in one aggregate pager session, then show each change in turn.
6. Accept the new content and provenance baseline, restore the old baseline, or leave the change for later.

This makes update source selection consistent across machines sharing the same host commit. On an older host, `slinky save` creates `.skill-lock.json` from manifest provenance and compatible machine metadata before committing it.

### Reviewing drift directly

```bash
slinky diff frontend-design --patch
slinky diff frontend-design --hunk
slinky diff frontend-design --delta
slinky vendor frontend-design   # accept the live copy
slinky restore frontend-design  # reject and restore the baseline
slinky restore all              # catalog wins for every drifting live vendor
```

`--patch` prints a unified patch. `--hunk` opens an interactive review in Hunk, while `--delta` streams the patch through Delta. The generic `--pager hunk|delta` form is equivalent. Pager mode sends one clean patch stream for all selected drifting skills and requires the selected executable on `PATH`. A recorded pager (see [Configuration](#configuration)) applies to both `diff` and `update`; a flag overrides it for one run, and `--no-pager` forces inline output.

## Project links

Copy a skill into a project, which is the default:

```bash
slinky link frontend-design /path/to/project
```

By default Slinky adds its created paths to the project's `.git/info/exclude`. It also creates a `.claude/skills` symlink when the project already has a `.claude/` directory. Use `--no-exclude` or `--no-claude` to disable those behaviors.

Or keep the project connected to the host copy:

```bash
slinky link frontend-design /path/to/project --symlink
```

Inspect and remove recorded links:

```bash
slinky links --check
slinky unlink frontend-design /path/to/project
```

Slinky refuses to remove modified copies or replaced symlinks unless `--force` is explicitly requested.

## Configuration

`~/.config/slinky/config.json` records the host plus three optional preferences:

```bash
slinky config diff-pager delta   # or hunk, or none to print inline
slinky config editor "code -w"   # or none to fall back to $VISUAL/$EDITOR
slinky config theme nord         # or none for the default; t in the TUI previews them
slinky config                    # show the recorded host, pager, editor, and theme
```

## Safety

- Preview reconciliation with `slinky sync --dry-run`.
- Preview bootstrap with `slinky bootstrap --dry-run`.
- Treat `bootstrap --clone ... --dry-run` as setup plus a reconciliation preview: cloning and config writes still occur.
- Dry-run reports foreign skills but does not preview `--adopt-all`; run `slinky adopt` to review candidates explicitly.
- Avoid `--force` until the conflicting path has been inspected.
- Commit or stash host baseline changes, and `slinky sync` pending store commits, before running `slinky update`.
- Do not hand-edit `.local/state.json`; use enable, disable, profile, link, and unlink commands.
- Review host repository changes after adoption or accepted updates.

## Host discovery

`slinky init` writes the host location to `~/.config/slinky/config.json`. Resolution order is:

1. `$SLINKY_REPO`
2. `~/.config/slinky/config.json`
3. Parent directories of the Slinky source checkout
4. Parent directories of the current working directory

## CLI reference

```bash
slinky                         # open the terminal UI
slinky version                 # print the installed version
slinky status                  # inspect catalog, live state, and Claude visibility
slinky sync --dry-run          # preview reconciliation
slinky sync [--force]          # apply reconciliation
slinky pull [--dry-run] [--force]
slinky push [--dry-run]
slinky enable <skill...>
slinky disable <skill...> [--force]
slinky profile list
slinky profile apply <name> [--force]
slinky config                         # show recorded host, diff pager, editor, and theme
slinky config diff-pager [hunk|delta|none]
slinky config editor [<command>|none] # e.g. "code -w"; falls back to $VISUAL, $EDITOR, nvim
slinky config theme [<id>|none]       # e.g. nord, catppuccin-latte; t in the TUI lists them
slinky update --check
slinky update [skill...] [--yes] [--hunk|--delta|--pager <hunk|delta>|--no-pager]
slinky skills add <source> [--skill <name>...]
slinky diff [skill...] [--patch|--hunk|--delta|--pager <hunk|delta>|--no-pager]
slinky vendor <skill...>
slinky restore <skill...>
slinky restore all                    # catalog wins for every drifting live vendor
slinky rehash [local-skill...]        # no names: every stale local skill
slinky adopt                          # list staged + host skills not in the repo
slinky adopt <skill...>|all [--local] [--owner=<owner>] # `--all` is also supported
slinky save [-m|--message <message>]
slinky link <skill> [project] [--copy|--symlink] [--no-exclude] [--no-claude]
slinky unlink <skill> [project] [--force]
slinky links [--check]
slinky verify
```
