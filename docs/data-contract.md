# Data Contract

A skills host is recognized by `skills.manifest.json`. All catalog mutations, vendored updates, and `.local/state.json` writes occur in that host repository.

Slinky validates its owned JSON documents with Effect Schema. Unknown properties, unsafe paths, malformed hashes, and invalid cross-references are errors. State loading explicitly normalizes retired profiles and disabled skills that no longer exist; dangling project links remain errors. A missing state file starts from an empty state, and a malformed state file is never silently reset.

## Manifest

`skills.manifest.json` uses the initial version-1 contract:

```json
{
  "version": 1,
  "skills": {
    "my-skill": {
      "origin": "local",
      "path": "skills/my-skill",
      "contentHash": "0000000000000000000000000000000000000000000000000000000000000000"
    },
    "their-skill": {
      "origin": "vendor",
      "path": "vendor/acme/their-skill",
      "contentHash": "0000000000000000000000000000000000000000000000000000000000000000",
      "upstream": {
        "kind": "github",
        "repository": "acme/skills",
        "url": "https://github.com/acme/skills",
        "tracking": {
          "kind": "tree",
          "path": "skills/their-skill/SKILL.md",
          "hash": "0000000000000000000000000000000000000000"
        }
      },
      "vendoredAt": null
    }
  },
  "profiles": {
    "default": ["my-skill", "their-skill"]
  }
}
```

Local paths must stay below `skills/` and end with the skill name. Vendor paths must use `vendor/<owner>/<name>`. Profile members must reference skills in the same manifest.

A local skill created by `slinky fork` also carries an optional `forkedFrom`:

```json
{
  "origin": "local",
  "path": "skills/my-their-skill",
  "contentHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "forkedFrom": {
    "skill": "their-skill",
    "upstream": { "kind": "github", "repository": "acme/skills", "url": "https://github.com/acme/skills", "tracking": { "kind": "tree", "path": "skills/their-skill/SKILL.md", "hash": "0000000000000000000000000000000000000000" } },
    "contentHash": "0000000000000000000000000000000000000000000000000000000000000000",
    "forkedAt": "2026-09-12T00:00:00.000Z"
  }
}
```

`skill` is the vendor's catalog name at fork time, `upstream` is a copy of its provenance, and `contentHash` is the vendor baseline the fork started from. It is informational: forks are ordinary local skills and have no `.skill-lock.json` entry. A manifest containing `forkedFrom` does not load on Slinky releases that predate it.

Vendor `upstream` values are discriminated by `kind`:

- `github` stores a repository, a nullable `url`, and either tree tracking or an explicit untracked state.
- `well-known` stores the source identifier and a nullable `url`.
- `unknown` stores a nullable explanatory `note`.

## Vendor Lock

The host's committed `.skill-lock.json` uses skills.sh's global version-3 lock shape:

```json
{
  "version": 3,
  "skills": {
    "their-skill": {
      "source": "acme/skills",
      "sourceType": "github",
      "sourceUrl": "https://github.com/acme/skills.git",
      "skillPath": "skills/their-skill/SKILL.md",
      "skillFolderHash": "0000000000000000000000000000000000000000"
    }
  }
}
```

This document contains only entries for manifest vendor skills. It is authoritative for update source selection and must agree with manifest provenance. Slinky preserves update-critical provider fields, but excludes machine preferences such as dismissed prompts and selected agents.

Before `slinky update` or bootstrap, Slinky merges managed entries into the machine lock at `~/.agents/.skill-lock.json`, or `$XDG_STATE_HOME/skills/.skill-lock.json` when configured. Unrelated machine entries and preferences are preserved. Global and staged adoption absorb usable provenance into the committed lock; `<repo>/skills-lock.json` remains a temporary project-scoped staging lock and is pruned after adoption.

## State

Machine-local `.local/state.json` records either custom exceptions to the default-enabled catalog or a profile identity:

```json
{
  "version": 2,
  "selection": {
    "kind": "custom",
    "disabledSkills": []
  },
  "projectLinks": [],
  "recentProjects": []
}
```

Profile selection uses `{"kind":"profile","name":"default"}` and derives enabled skills from the current manifest profile membership. If that profile is retired, state normalizes to an all-enabled custom selection. Version-1 state is migrated on load; existing profile identity wins, while a retired profile keeps its still-valid disabled skills as a custom selection. Project links and custom disabled skills must reference manifest skills.

Version-2 state also accepts optional host-local OpenCode invocation preferences:

```json
"opencode": {
  "autoinvoke": {
    "make-pr": false,
    "research": true
  }
}
```

Each key is a catalog skill ID. `false` means manual invocation; `true` explicitly allows automatic discovery. A missing key means inherit. Preferences survive selection changes; entries for retired catalog skills are pruned on state alignment. The manifest and upstream hashes always describe source content, without host-local additions.

Global installation receipts live in `~/.agents/.slinky/receipts/<skill>.json`. They record the original and rendered frontmatter and the source path. Generated local copies live in `~/.agents/.slinky/rendered/<skill>`, outside discovery roots, with the usual `~/.agents/skills/<skill>` symlink pointing there. Receipts also record generated-copy hashes to detect direct edits. Vendor copies remain real directories. Diff, vendor acceptance, and updates use receipts to remove only Slinky's marked metadata; source hashes exclude those additions.

A copy project link records:

```json
{
  "mode": "copy",
  "project": "/absolute/path/to/project",
  "skill": "my-skill",
  "targets": [".agents/skills/my-skill"],
  "excludedTargets": [".agents/skills/my-skill"],
  "linkedAt": "2026-07-14T00:00:00.000Z",
  "snapshotHash": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

Symlink links use `"mode": "symlink"` and omit `snapshotHash`. Targets are limited to the canonical `.agents/skills/<name>` path and the optional `.claude/skills/<name>` link.

## Config

`slinky init` writes `~/.config/slinky/config.json`:

```json
{
  "version": 1,
  "host": "/absolute/path/to/my-agent-skills",
  "diffPager": "delta",
  "editor": "code -w",
  "theme": "nord"
}
```

A leader machine also records its followers:

```json
{
  "fleet": [
    { "name": "devbox", "ssh": "me@devbox.tail1234.ts.net" },
    { "name": "pi", "ssh": "pi.local", "command": "~/.bun/bin/slinky" }
  ]
}
```

`fleet` is optional and keeps registration order. Names are unique and use letters, digits, `.`, `_`, and `-`. `ssh` is an ssh destination without whitespace or a leading dash. `command` is an optional remote shell command that stands in for `slinky` when it is not on the non-interactive ssh `PATH`. Removing the last follower removes the property.

`diffPager` is optional and accepts `hunk` or `delta`. `editor` is an optional nonblank command specification, including arguments. `theme` is an optional TUI palette id (the `t` picker in the TUI lists them, e.g. `nord`, `catppuccin-latte`); absent means `slinky`. Clearing any of these settings removes its property rather than writing `null` or `"none"`. The editor resolves from the configured value, then `$VISUAL`, `$EDITOR`, and finally `nvim`. `SLINKY_REPO` can override the configured host for one invocation.
