---
"@gcavanunez/slinky": minor
---

Record a preferred diff pager and review updates in one session. `slinky config diff-pager <hunk|delta|none>` persists the choice in `~/.config/slinky/config.json`, and `slinky config` shows the recorded host and pager. Both `slinky diff` and `slinky update` use it, with the existing `--hunk`/`--delta`/`--pager` flags overriding it for one run and a new `--no-pager` forcing inline output.

`slinky update` now collects every changed skill into a single aggregate patch and opens that one pager session before prompting, instead of dumping each unified diff into the terminal where it could not be read. Writing one config field no longer drops another, so setting a pager survives a later `slinky init`.
