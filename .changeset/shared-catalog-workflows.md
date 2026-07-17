---
"@gcavanunez/slinky": patch
---

Consolidate catalog mutations into shared application workflows used by both the CLI and TUI. `enable`, `disable`, and `profile apply` with `--dry-run` no longer persist state; previews leave `.local/state.json` and the global stores untouched. Project-link timestamps are now constructed through the canonical encoded form, and immutable aggregate transitions validate decoded values correctly.
