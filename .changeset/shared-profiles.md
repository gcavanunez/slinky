---
"@gcavanunez/slinky": minor
---

Make profiles the shared on/off state for a fleet. Enabling or disabling a skill while following a profile now records a change for this machine only instead of dropping the profile, so the machine keeps picking up profile edits on sync. `slinky profile add` and `profile remove` edit a profile in the manifest (creating it if needed), `profile promote` moves this machine's changes into its profile, `profile create`, `rename`, and `delete` complete the set, and `status`, `profile list`, and the TUI show what the machine follows. The TUI profiles modal (`p`) now creates, edits (as a skill checklist), renames, and deletes profiles too.
