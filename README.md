# Slinky

```text
skills host                          global agent stores
├─ skills/              ┐            ~/.agents/skills/
├─ vendor/              ├─ slinky ─> ~/.claude/skills/
└─ skills.manifest.json ┘            project-local skills
```

Slinky keeps your coding-agent skills in one versioned repository and reconciles them into the global stores agents read from. Skills you write live in `skills/`; skills you pull from others are vendored under `vendor/` with their upstream provenance, so they can be updated, diffed, and shared across machines through git.

## Install

```bash
npm install --global @gcavanunez/slinky
npx skills add gcavanunez/slinky --skill slinky --global --yes   # the agent-facing skill
```

The npm package installs a standalone binary for macOS and glibc Linux on ARM64 and x64; Bun is not required at runtime. Archives are also attached to each [GitHub release](https://github.com/gcavanunez/slinky/releases). Slinky needs Git, `tar`, `diff`, and Node.js/`npx` on `PATH`.

## Quick start

```bash
slinky init /path/to/my-agent-skills     # record the host repo
slinky bootstrap --dry-run               # see what would change
slinky bootstrap                         # back up, materialise, verify
slinky                                   # open the TUI
```

On another machine, clone and set up in one step:

```bash
slinky bootstrap --clone=https://github.com/you/my-agent-skills.git
```

Starting from nothing? The [guide](docs/guide.md#bootstrap) shows how to create an empty host.

## Everyday use

```bash
slinky status                            # catalog, live state, drift
slinky enable <skill>                    # or disable, or profile apply <name>
slinky autoinvoke <skill> off            # keep installed; activate explicitly in OpenCode
slinky skills add owner/repo --skill x   # vendor a skill from skills.sh
slinky update --check                    # anything new upstream?
slinky update                            # review and accept changes
slinky sync                              # save, pull, reconcile, restore
```

`sync` is the whole loop: it commits reviewed catalog changes, pulls the upstream, rebuilds the global stores, and resets live vendor copies to the catalog. Preview it with `--dry-run`.

To keep other machines current without logging into each one, register them on the machine that can push and let it drive them over ssh:

```bash
slinky fleet add devbox me@devbox          # once per follower
slinky fleet sync                          # sync + push here, then each follower pulls and restores
```

The [guide](docs/guide.md#fleet) covers the details.

## The TUI

One catalog tree on the left, the selected skill's documentation on the right.

![The Slinky TUI: a folded catalog tree beside a skill's documentation](docs/images/tui.png)

| key             | does                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| `j/k` `h/l`     | move; fold or unfold a group                                                          |
| `space`         | toggle a skill, or every skill in a group from its heading                            |
| `A`             | cycle OpenCode invocation: manual, automatic, inherit                                 |
| `z` / `Z`       | fold one group / fold all                                                             |
| `/`             | filter the catalog, or search the document                                            |
| `enter` `i`     | open the document / show details                                                      |
| `d` `u`         | diff a drifting vendor skill / check upstream                                         |
| `e` `a` `L` `p` | edit, index/adopt a skill, link into a project, manage profiles                       |
| `1` `2` `3`     | available here, all skills, skills waiting to be adopted                              |
| `F`             | fork a vendor skill into `skills/` as your own copy                                   |
| `S`             | run `slinky sync`; the tab row shows `⇣ N to pull` when the store has commits waiting |
| `t`             | pick a theme (27 available, previewed live)                                           |
| `x` `v` `<` `>` | zoom, cycle layouts, resize                                                           |
| `?`             | everything else                                                                       |

## How it fits together

- **Local skills** in `skills/` are symlinked into `~/.agents/skills`. When OpenCode invocation metadata is needed, the symlink points to a generated copy refreshed during reconciliation.
- **Vendor skills** in `vendor/` are committed baselines, copied into the store so `npx skills` can update them; `slinky update` shows you the diff before anything changes in the catalog.
- **Profiles** in the manifest are shared enabled sets; a machine following one gets its edits on sync, and can still enable or disable a skill for itself. **Machine state** (`.local/state.json`, gitignored) records what this machine follows or disables, and which projects have links.
- **Project links** copy or symlink a catalog skill into another repository, excluded from that repo's git by default.

### OpenCode invocation

Keep a skill available for explicit use without advertising it to OpenCode's model:

```bash
slinky autoinvoke make-pr off --dry-run
slinky autoinvoke make-pr off
slinky autoinvoke make-pr on         # explicitly allow automatic discovery
slinky autoinvoke make-pr inherit    # follow the skill's frontmatter again
```

Preferences live in the catalog's gitignored `.local/state.json` and survive disable/re-enable and profile changes. `status` shows the effective setting and whether it comes from this host, upstream metadata, compatibility translation, or the default.

Slinky adds `metadata.opencode/autoinvoke` to global installations while preserving catalog sources and upstream provenance. Without a host preference, explicit upstream OpenCode metadata wins; otherwise `disable-model-invocation: true` translates to manual invocation. Skills with neither field retain OpenCode's default behavior.

`off` keeps explicit activation available. It does not change slash-command visibility. These preferences apply to global copies; project-local definitions and higher-priority OpenCode sources can take precedence. See [OpenCode V2's skill documentation](https://opencode.ai/v2/docs/skills/) for discovery rules.

The catalog repo is yours; Slinky only owns the tooling. Save it with `slinky save`, share it with `slinky push`, and each machine's `slinky sync` keeps up.

## Documentation

- [Guide](docs/guide.md): every workflow in depth, TUI bindings, safety notes, and the full CLI reference.
- [Data contract](docs/data-contract.md): the manifest, state, lock, and config formats.
- [Slinky skill](skills/slinky/SKILL.md): what an agent reads to drive Slinky for you.

## Development

```bash
git clone https://github.com/gcavanunez/slinky.git
cd slinky
bun install
bun test
bun run typecheck
bun run build:bin          # dist/slinky for this platform
```

Bun 1.3 or newer. `bun run package:smoke` builds and installs the npm package the way a release does.

## Credits

This project draws inspiration from and utilities from:

- [ghui](https://github.com/kitlangton/ghui)
- [mail-control](https://github.com/kitlangton/mail-control)
