---
"@gcavanunez/slinky": minor
---

Stop making a stale local hash block `slinky save`. Local skills are symlinked into the global store, so editing the installed copy edits the repo copy directly and leaves the manifest hash behind; `save` already committed that content, so the mismatch was bookkeeping rather than a reason to abort. `slinky save` now refreshes stale local hashes itself and prints each skill it touched, and `slinky rehash` with no arguments sweeps every stale local skill. Vendor skills are still excluded: a hash mismatch on a committed baseline means it was hand-edited instead of going through `slinky vendor`, and that remains a verification failure.
