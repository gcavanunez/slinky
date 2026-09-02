---
"@gcavanunez/slinky": patch
---

Route CLI and TUI catalog behavior through shared application operations. Adoption now compensates manifest, state, lock, and filesystem changes as one transaction; save, pull, push, and sync own their Git lifecycle outside the CLI adapter; and catalog inspection consistently rejects wrong-target links. Machine state migrates to a version-2 custom/profile selection that derives profile membership without caching duplicate disabled-skill state.
