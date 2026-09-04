---
"@gcavanunez/slinky": minor
---

Notice unpulled catalog commits: `slinky update` refuses to run on a store behind its upstream (`--force` overrides) and `update --check` reports it; the TUI checks in the background on launch, shows `⇣ N to pull`, and `S` runs `slinky sync` in a scrollable modal.
