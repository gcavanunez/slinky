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
compatibility: Requires the slinky CLI, Bun 1.3+, Git, tar, diff, Node.js/npx, and network access for upstream operations.
---

# Slinky

Use the local `slinky` CLI to manage the desired state of an agent skills catalog. The catalog lives in a separate skills host repository; Slinky materializes it into global and project-local skill directories.

## Setup

Confirm the CLI is available:

```bash
slinky help
```

Install the CLI with `bun add --global @gcavanunez/slinky`, then install this skill with `npx skills add gcavanunez/slinky --skill slinky --global --yes`. The repository README has separate source-checkout instructions for contributors.

Point it at an existing skills host:

```bash
slinky init /path/to/my-agent-skills
```

For a new machine with no host checkout:

```bash
slinky bootstrap --clone=https://github.com/owner/my-agent-skills.git
```

Use `SLINKY_REPO=/path/to/host` for a one-command override. Do not guess which host is active; run `slinky status` before catalog mutations.

Slinky expects the host to contain `skills.manifest.json`. If the user needs an empty host, create `skills/`, `vendor/`, an initial `{ "version": 1, "skills": {}, "profiles": {} }` manifest, and a `.gitignore` entry for `.local/`. Initialize Git and commit that baseline before running `slinky init`.

## Mental Model

```text
skills host
├─ skills/                 locally authored source
├─ vendor/                 committed upstream baselines
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

Slinky runs `npx skills update`, compares live copies with committed baselines, and asks whether to accept, reject, or skip each change.

Inspect or resolve a specific drift directly:

```bash
slinky diff <skill> --patch
slinky vendor <skill>   # accept live content as the new baseline
slinky restore <skill>  # restore live content from the current baseline
```

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
- Treat `--force`, `--adopt-all`, and `update --yes` as explicit user decisions.
- Do not edit `.local/state.json` or global skill directories by hand.
- Do not delete vendor drift before showing `slinky diff` or explaining the restore/vendor choice.
- Keep the skills host under Git and review its diff after adoption or accepted updates.
- Keep `.local/` ignored because state can contain absolute project paths and machine-specific preferences.
- If Slinky reports an unowned file or directory, stop and inspect it rather than forcing replacement automatically.

## Reporting

Tell the user:

- Which host and skills were affected.
- Which commands were run.
- Whether changes were previewed or applied.
- Which warnings, skipped actions, or unresolved drift remain.
- Whether the host repository now has changes to review or commit.
