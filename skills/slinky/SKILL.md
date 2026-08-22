---
name: slinky
description: >
  User guide for the local `slinky` CLI and terminal UI for managing agent
  skill catalogs, global skill stores, profiles, upstream vendor updates,
  adoption, and project-local skill links. Use this skill whenever someone
  asks an agent to inspect, install, enable, disable, synchronize, update,
  vendor, restore, adopt, or link coding-agent skills through Slinky. Prefer
  Slinky commands over editing its machine state or global skill directories
  by hand.
compatibility: Requires the slinky CLI, Git, tar, diff, Node.js/npx, and network access for upstream operations.
---

# Slinky

Use the local `slinky` CLI to manage the desired state of an agent skills catalog. The catalog lives in a separate skills host repository; Slinky materializes it into global and project-local skill directories.

## Setup

Confirm the CLI is available:

```bash
slinky help
```

Install the CLI with `npm install --global @gcavanunez/slinky`, then install this skill with `npx skills add gcavanunez/slinky --skill slinky --global --yes`. The repository README has separate source-checkout instructions for contributors.

Point it at an existing skills host:

```bash
slinky init /path/to/my-agent-skills
```

For a new machine with no host checkout:

```bash
slinky bootstrap --clone=https://github.com/owner/my-agent-skills.git
```

Use `SLINKY_REPO=/path/to/host` for a one-command override. Do not guess which host is active; run `slinky status` before catalog mutations.

Slinky expects the host to contain `skills.manifest.json`. If the user needs an empty host, create `skills/`, `vendor/`, an initial `{ "version": 1, "skills": {}, "profiles": {} }` manifest, a `.skill-lock.json` containing `{ "version": 3, "skills": {} }`, and a `.gitignore` entry for `.local/`. Initialize Git and commit that baseline before running `slinky init`.

## Mental Model

```text
skills host
├─ skills/                 locally authored source
├─ vendor/                 committed upstream baselines
├─ .skill-lock.json        committed vendor update provenance
├─ skills.manifest.json    catalog and profiles
└─ .local/state.json       machine-local desired state
          │
          └─ slinky sync
             ├─ ~/.agents/skills
             └─ ~/.claude/skills

slinky link ──────────────> project-local skill directories
```

Local skills are symlinked from the host. Vendor skills are real directories in the global store so `npx skills` can update them, while the host retains the reviewable baseline.

## Default Workflow

Inspect before changing anything:

```bash
slinky status
slinky sync --dry-run
```

Apply reconciliation only after the preview matches the requested outcome:

```bash
slinky sync
```

After a mutation, run `slinky status` again and report warnings or skipped actions to the user.

## Enablement And Profiles

New skills are enabled by default. Change individual skills with:

```bash
slinky enable <skill...>
slinky disable <skill...>
```

Profiles are exact enabled sets:

```bash
slinky profile list
slinky profile apply <name>
```

Applying a profile disables every catalog skill outside it. A later individual enable or disable clears the active profile.

After editing a local skill under `skills/`, refresh its content hash before verification:

```bash
slinky rehash <local-skill...>
slinky verify
```

Install a new upstream skill through Slinky rather than invoking skills.sh directly:

```bash
slinky skills add <source>                         # skills.sh picks, Slinky vendors
slinky skills add <source> --skill <name>          # or name them
slinky skills add <source> --skill a --skill b
```

Slinky never implements skill discovery. It runs `npx skills add` project-scoped inside the host repo (`--project -a universal`), so omitting `--skill` hands you skills.sh's own picker. skills.sh cannot install into `vendor/<owner>/<name>` — its target directory is a fixed constant — so it writes to the repo's `.agents/skills/` staging inbox and Slinky consolidates from there: vendor by owner, index in the manifest, reconcile, clear the inbox.

Never edit anything under `.agents/skills/`. It is a handoff point, and re-running `npx skills add` overwrites it silently.

You can also fill the inbox yourself and consolidate later:

```bash
cd <host-repo>
npx skills add <source>     # skills.sh installs into .agents/skills/
slinky adopt                # review what is staged
slinky adopt all            # vendor, index, and sync every candidate
```

`slinky adopt` lists staged skills next to host skills missing from the manifest; `slinky adopt all` imports every candidate, with `slinky adopt --all` retained as an equivalent flag form. A staged copy wins its name when both exist. Staged provenance comes from temporary `<repo>/skills-lock.json`; global provenance comes from the machine skills.sh lock. Usable entries are absorbed into committed `<repo>/.skill-lock.json`. Project-scoped locks omit the git tree hash, so Slinky recovers it from GitHub to keep `update --check` working, falling back to untracked when that call fails. After adopting, Slinky clears the staging dir, removes the dangling `.claude` symlink, and prunes the temporary lock entry; a staged copy identical to an indexed baseline is discarded as redundant. Agent directories that a hand-run `npx skills add` populated are reported, not deleted.

A staged copy that differs from an already-indexed baseline is left alone: updating a vendored skill from the inbox is not supported yet, so use `slinky update` for that.

For an unindexed skill, select it in the TUI and press `a`. Enter the source alone or paste the matching `skills add <source> --skill <name>` command. Slinky indexes existing `skills/` and `vendor/` directories in place; it removes an old host-local `.agents` copy only when its content matches the global installation.

## Upstream Updates

Check persisted upstream tree hashes without changing live skills:

```bash
slinky update --check
```

Only GitHub vendors with persisted tree provenance can be checked. Treat `unchecked` as unknown, not current; it can indicate a well-known or untracked source, a private repository, a rate limit, or a request failure.

Run an interactive update for selected vendor skills:

```bash
slinky update <skill...>
```

Slinky first seeds selected entries in the machine skills.sh lock from committed `.skill-lock.json`, then runs `npx skills update`, compares live copies with committed baselines, and asks whether to accept, reject, or skip each change. Accepted updates advance both content and provenance; rejected or skipped updates leave the committed provenance unchanged. This makes source selection consistent across machines sharing a host commit.

Inspect or resolve a specific drift directly:

```bash
slinky diff <skill> --patch
slinky diff <skill...> --hunk
slinky diff <skill...> --delta
slinky diff <skill...> --pager hunk
slinky vendor <skill>   # accept live content as the new baseline
slinky restore <skill>  # restore live content from the current baseline
slinky restore all      # restore every drifting live vendor from the catalog
```

Pager mode opens one clean patch stream for all selected drifting skills. Use `--hunk` for interactive review, `--delta` for terminal rendering, or the equivalent `--pager hunk|delta` form.

In the TUI, dragging across text copies it automatically. `Ctrl-C` copies an active text selection; without a selection it retains the normal quit behavior. `v` and `V` cycle forward or backward through three panes, a contextual two-pane layout, and the focused pane at full width; `<` and `>` resize the focused side of a two-pane split. On a local catalog skill or unindexed local skill, `e` suspends the TUI and opens the skill in `nvim` from the skills host directory; vendor, staging-inbox, and project-only copies are excluded.

In the TUI, author and category rows show a yellow `⚠` when any of their visible skills has confirmed drift. Select a drifting vendor skill and press `d`. The drift review accepts `a` to vendor the live global copy, `r` to restore the repository baseline, `h` to open Hunk, and `d` to open Delta.

Do not use `update --yes` unless the user explicitly wants every detected change accepted without individual review. Host baseline changes must be committed or stashed before updating.

## Adopting Existing Skills

List global skills that are not represented in the host:

```bash
slinky adopt
```

Import selected skills after reviewing the candidates:

```bash
slinky adopt <skill...>
slinky adopt <skill...> --local
slinky adopt --all
```

The default is a vendor skill. Use `--local` only for skills the user intends to author in the host. After adoption, inspect the host with `git status` and `git diff`.

Commit reviewed catalog changes without capturing unrelated staged work:

```bash
slinky save
slinky save --message "Add project skills"
```

`save` rejects unindexed `skills/` or `vendor/` directories, verifies manifest hashes and vendor provenance, and commits only `.skill-lock.json`, the manifest, and indexed skill directories. It does not include staged paths elsewhere in the host. On an older host, `save` creates the committed lock from manifest provenance and compatible machine metadata.

Share that commit through the branch's configured upstream:

```bash
slinky push
```

On another machine, fast-forward and reconcile with either form:

```bash
slinky pull
slinky sync --pull
```

These commands require a clean host worktree and a configured upstream. Pull is fast-forward only and preserves local disabled skills, project links, recent projects, and profiles that still exist. It blocks removal of a skill that has a local project link. Use `pull --dry-run` or `sync --pull --dry-run` to fetch and inspect whether an update would be applied without changing the checked-out catalog or global skills.

## Project Links

Copy a skill into a project by default:

```bash
slinky link <skill> /path/to/project
```

The default link updates the project's `.git/info/exclude`. If the project already has `.claude/`, it also creates a Claude skill symlink. Use `--no-exclude` or `--no-claude` when the user does not want those side effects.

Use a symlink when the project should always follow the host copy:

```bash
slinky link <skill> /path/to/project --symlink
```

Inspect and remove links with:

```bash
slinky links --check
slinky unlink <skill> /path/to/project
```

Copy mode records a snapshot hash and refuses to remove locally modified content. Symlink mode refuses to remove a path that was replaced or retargeted. Inspect first; use `--force` only when the user intends to discard the conflicting path.

## Bootstrap

Preview first-run reconciliation:

```bash
slinky bootstrap --dry-run
```

Then apply it:

```bash
slinky bootstrap
```

Bootstrap backs up global skill directories before mutation. If it reports foreign skills, leave them untouched unless the user chooses specific adoptions or explicitly requests `--adopt-all`.

`bootstrap --clone ... --dry-run` still clones the remote and writes Slinky's config; only the later reconciliation is a dry run. Dry-run reports foreign skills but does not preview `--adopt-all`, so use `slinky adopt` to review candidates. Backups are stored under `~/.local/state/my-agent-skills-backups`. There is no automatic undo command, so inspect an archive before manually restoring it.

## Safety Rules

- Prefer preview commands: `sync --dry-run`, `bootstrap --dry-run`, and `update --check`.
- Treat `--force`, `--adopt-all`, `adopt all`, `restore all`, and `update --yes` as explicit user decisions.
- Do not edit `.local/state.json` or global skill directories by hand.
- Do not delete vendor drift before showing `slinky diff` or explaining the restore/vendor choice.
- Keep the skills host under Git and review its diff after adoption or accepted updates.
- Use `slinky save` after review when the catalog changes should become the new committed baseline.
- Use `slinky push` after saving, and `slinky pull` on other machines; do not replace these safety checks with force-pushes or merge pulls.
- Keep `.local/` ignored because state can contain absolute project paths and machine-specific preferences.
- If Slinky reports an unowned file or directory, stop and inspect it rather than forcing replacement automatically.

## Reporting

Tell the user:

- The installed version from `slinky version` when diagnosing behavior that may differ between releases.
- Which host and skills were affected.
- Which commands were run.
- Whether changes were previewed or applied.
- Which warnings, skipped actions, or unresolved drift remain.
- Whether the host repository now has changes to review or commit.
