# Data Contract

A skills host is recognized by `skills.manifest.json`. All catalog mutations, vendored updates, and `.local/state.json` writes occur in that host repository.

Slinky validates its owned JSON documents with Effect Schema. Unknown properties, unsafe paths, malformed hashes, and invalid cross-references are errors. A missing state file starts from an empty state; a malformed state file is never silently reset.

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

Machine-local `.local/state.json` records exceptions to the default-enabled catalog:

```json
{
  "version": 1,
  "disabledSkills": [],
  "activeProfile": null,
  "projectLinks": [],
  "recentProjects": []
}
```

When `activeProfile` is set, `disabledSkills` must exactly match the skills outside that profile. Project links and disabled skills must reference manifest skills.

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
  "host": "/absolute/path/to/my-agent-skills"
}
```

`SLINKY_REPO` can override the configured host for one invocation.
