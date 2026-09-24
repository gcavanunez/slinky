---
"@gcavanunez/slinky": minor
---

Add `slinky fleet` so one leader machine can keep the others current: `fleet add <name> <ssh-target>` records a follower in the leader's config, and `fleet sync` syncs and pushes the leader, then runs the new `sync --follower` (pull, reconcile, restore; never save) on every follower over ssh in parallel.

Fix `pull` and `sync` failing with "no deterministic update provenance" once a vendor skill of unknown origin matched its catalog baseline.
