---
"@gcavanunez/slinky": patch
---

Fix the TUI failing to start from a project that sets its own `jsxImportSource`. Bun resolves `tsconfig.json` from the current working directory rather than from the source file, so running `slinky` inside (for example) a Vue project transformed the TUI's JSX against that project's runtime and failed with `Cannot find module 'vue/jsx-dev-runtime'`. The TUI's `.tsx` files now pin `@jsxImportSource @opentui/react` per file.
