# Slinky

```text
skills host                  global agent stores
├─ skills/      ─┐           ~/.agents/skills/
├─ vendor/       ├─ slinky ─> ~/.claude/skills/
└─ skills.manifest.json ┘    project-local skills
```

Agent-first skill catalog management. Slinky keeps local and vendored skills in a versioned host repository, then reconciles them into the global stores used by coding agents.

Humans can use the terminal UI directly, but the happy path also works well through an agent using the bundled Slinky skill.

## Install

```bash
npm install --global @gcavanunez/slinky
```

The npm package installs the standalone binary for the current platform; Bun is not required at runtime. Prebuilt archives for macOS and glibc-based Linux on ARM64 and x64 are also attached to each [GitHub release](https://github.com/gcavanunez/slinky/releases) for installations that do not use npm.

Install the agent skill too:

```bash
npx skills add gcavanunez/slinky --skill slinky --global --yes
```

Slinky requires Git, `tar`, `diff`, Node.js/`npx`, and network access for upstream checks and updates. Bun 1.3 or newer is required only for source development.

## Getting Started

Point Slinky at an existing skills host:

```bash
slinky init /path/to/my-agent-skills
slinky bootstrap --dry-run
slinky bootstrap
```

`bootstrap` backs up existing global skill directories, reports skills the host does not know about, materializes enabled skills, and verifies the catalog. Use `--adopt-all` only when every reported foreign skill should be imported.

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
printf '.local/\n' > ~/my-agent-skills/.gitignore
git -C ~/my-agent-skills init
git -C ~/my-agent-skills add skills.manifest.json .gitignore
git -C ~/my-agent-skills commit -m "Initialize skills catalog"
slinky init ~/my-agent-skills
```

Keep `.local/` ignored because state contains machine-specific preferences and absolute project paths. Existing global skills can then be imported with `slinky adopt` or `slinky adopt <name> --local`.

Open the terminal UI:

```bash
slinky
```

The TUI is arranged as `authors | skills | document`, with a related-file tree on the document's right edge. Use `h/j/k/l` or the arrow keys to focus and navigate panels, `gg`/`G` to jump to boundaries, and `x` to expand the focused primary panel to the full terminal.

Or inspect the catalog from the CLI:

```bash
slinky status
slinky sync --dry-run
slinky sync
```

For a fresh machine, clone and initialize a host in one step:

```bash
slinky bootstrap --clone=https://github.com/you/my-agent-skills.git
```

The clone form requires an existing remote host. Even with `--dry-run`, it still clones the repository and records its location; dry-run applies to reconciliation after setup.

## Agent Happy Path

1. Inspect the catalog and desired-state drift:

```bash
slinky status
slinky sync --dry-run
```

2. Enable, disable, or apply a profile:

```bash
slinky enable frontend-design
slinky disable legacy-skill
slinky profile apply default
```

3. Check upstream vendor skills without changing anything:

```bash
slinky update --check
```

Only vendor skills with persisted GitHub tree provenance can be checked. Well-known, unknown, private, rate-limited, or otherwise untracked sources appear as `unchecked`.

4. Review an update interactively:

```bash
slinky update frontend-design
```

5. Confirm the resulting catalog and repository changes:

```bash
slinky status
git -C /path/to/my-agent-skills diff
```

## Catalog Model

- **Local skills** live under `skills/` and are symlinked into the canonical global store.
- **Vendor skills** live under `vendor/` as committed baselines and are copied into the global store so `npx skills` can update them.
- **Profiles** define exact enabled sets.
- **Machine state** records disabled skills, the active profile, and project links in `.local/state.json`.
- **Project links** copy or symlink a catalog skill into another repository.

The application and catalog stay separate: Slinky owns the tooling, while the host repository owns `skills/`, `vendor/`, `commands/`, and `skills.manifest.json`.

After editing locally authored skill content, refresh its manifest hash and verify the catalog:

```bash
slinky rehash my-skill
slinky verify
```

Add an upstream skill through Slinky so skills.sh provenance, the vendored baseline, and the manifest are updated together:

```bash
slinky skills add kitlangton/skills                        # skills.sh picks, Slinky vendors
slinky skills add kitlangton/skills --skill effect         # or name them
slinky skills add plannotator/effective-html --skill html --skill html-plan
```

Slinky does not implement skill discovery. It runs `npx skills add` **project-scoped inside the host repo**, so with no `--skill` you get skills.sh's own picker. skills.sh cannot be pointed at `vendor/<owner>/<name>` — its install directory is a fixed constant — so it installs into the repo's `.agents/skills/` staging inbox, and Slinky consolidates from there: vendor by owner, index in the manifest, reconcile, and clear the inbox.

### The staging inbox

`<repo>/.agents/skills/` is a handoff point, never a place to edit. Re-running `npx skills add` overwrites it without warning.

Because it is just a directory, you can fill it yourself and let Slinky consolidate later:

```bash
cd ~/my-agent-skills
npx skills add mattpocock/skills     # skills.sh installs into .agents/skills/
slinky adopt                         # review what is staged
slinky adopt --all                   # vendor, index, and sync it
```

`slinky adopt` lists staged skills alongside host skills that are missing from the manifest. A staged copy wins its name when both exist. Adoption reads provenance from `<repo>/skills-lock.json` and, since project-scoped locks omit the git tree hash, recovers it from GitHub so `slinky update --check` keeps working; an unreachable upstream just leaves the skill untracked.

Afterwards Slinky clears the staging directory, removes the `.claude` symlink skills.sh left pointing at it, and prunes the adopted entry from `skills-lock.json`. A staged copy identical to a baseline already in the manifest is discarded as redundant. Running `npx skills add` yourself also copies into every agent directory it detects; Slinky reports those rather than deleting them, since they are in your worktree. Add `.agents/` to the host repo's `.gitignore` to keep the inbox out of git.

`slinky status` and the TUI also report skill directories under `skills/`, `vendor/`, or `.agents/skills/` that are missing from `skills.manifest.json`.

In the TUI, select an unindexed skill and press `a`. Enter the source (`kitlangton/skills`) or paste its add command (`skills add kitlangton/skills --skill effect`). Slinky verifies that the installed content matches the unindexed copy before indexing it in place or moving it to the inferred vendor path.

### Save the catalog

After reviewing catalog changes, verify and commit them in the skills host:

```bash
slinky save
slinky save --message "Add project skills"
```

`save` refuses unindexed directories under `skills/` or `vendor/`, verifies every manifest content hash, checks the staged catalog diff, and commits only `skills.manifest.json` plus skill directories referenced by the current or committed manifest. Other staged files, including loose files elsewhere under `skills/` or `vendor/`, are left out of the commit. The default commit message is `Update skills catalog`.

## Project Links

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

The TUI skill list shows project placement separately from global availability: `link·hid` and `copy·hid` are excluded through `.git/info/exclude`, while `link·git` and `copy·git` are visible to Git.

The TUI opens on the top-level `available here` tab, which hides unavailable catalog entries and shows only skills discoverable globally or through the current project's `.agents` and `.claude` directories. Press `2` for the complete catalog and `1` to return to available skills.

## Update Workflow

`slinky update` keeps the committed vendor baseline separate from the live copy updated by `npx skills`:

1. Require a clean `vendor/`, `skills/`, and manifest baseline.
2. Run the upstream update against the live global store.
3. Show each changed skill.
4. Accept the new baseline, restore the old baseline, or leave the change for later.

Use these commands when reviewing drift directly:

```bash
slinky diff frontend-design --patch
slinky vendor frontend-design   # accept the live copy
slinky restore frontend-design  # reject and restore the baseline
```

## Safety

- Preview reconciliation with `slinky sync --dry-run`.
- Preview bootstrap with `slinky bootstrap --dry-run`.
- Treat `bootstrap --clone ... --dry-run` as setup plus a reconciliation preview: cloning and config writes still occur.
- Dry-run reports foreign skills but does not preview `--adopt-all`; run `slinky adopt` to review candidates explicitly.
- Avoid `--force` until the conflicting path has been inspected.
- Commit or stash host baseline changes before running `slinky update`.
- Do not hand-edit `.local/state.json`; use enable, disable, profile, link, and unlink commands.
- Review host repository changes after adoption or accepted updates.
- Bootstrap backups are written under `~/.local/state/my-agent-skills-backups`; inspect an archive before manually restoring it into `$HOME`.

## CLI Reference

```bash
slinky                         # open the terminal UI
slinky status                  # inspect catalog, live state, and Claude visibility
slinky sync --dry-run          # preview reconciliation
slinky sync [--force]          # apply reconciliation
slinky enable <skill...>
slinky disable <skill...> [--force]
slinky profile list
slinky profile apply <name> [--force]
slinky update --check
slinky update [skill...] [--yes]
slinky skills add <source> [--skill <name>...]
slinky diff [skill] [--patch]
slinky vendor <skill...>
slinky restore <skill...>
slinky rehash <local-skill...>
slinky adopt                          # list staged + host skills not in the repo
slinky adopt <skill...>|--all [--local] [--owner=<owner>]
slinky save [-m|--message <message>]
slinky link <skill> [project] [--copy|--symlink] [--no-exclude] [--no-claude]
slinky unlink <skill> [project] [--force]
slinky links [--check]
slinky verify
```

## Host Discovery

`slinky init` writes the host location to `~/.config/slinky/config.json`. Resolution order is:

1. `$SLINKY_REPO`
2. `~/.config/slinky/config.json`
3. Parent directories of the Slinky source checkout
4. Parent directories of the current working directory

See [docs/data-contract.md](docs/data-contract.md) for the validated manifest, state, and config formats.

## Development

```bash
git clone https://github.com/gcavanunez/slinky.git
cd slinky
bun install
bun link
npx skills add . --skill slinky --global --yes
bun test
bun run typecheck
bun run build:bin
bun run build:standalone
bun run package:smoke
```

The local standalone executable is written to `dist/slinky`. The release build writes the current platform's archive, checksum, and staged executable under `dist/release/`.
