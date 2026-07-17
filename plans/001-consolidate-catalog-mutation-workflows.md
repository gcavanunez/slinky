# Plan 001: Consolidate Catalog Mutation Workflows

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: this repository had no `HEAD` commit when the plan was written. Run:
>
> ```bash
> sha256sum src/cli.ts src/tui/data.ts src/tui/App.tsx src/lib/reconcile.ts src/lib/linker.ts src/lib/manifest.ts
> ```
>
> Expected checksums are listed in "Current state." If an in-scope file differs, compare the cited excerpts against the live code. If mutation ownership has already moved or the excerpts no longer match semantically, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: no commit available (uncommitted initial tree), 2026-07-16

## Why This Matters

Slinky currently implements catalog mutations separately in the CLI and TUI. Enablement, profile application, linking, persistence, reconciliation, and compensation can therefore acquire different validation, dry-run, error, and rollback behavior depending on the entry point. A small application module should own these workflows while `src/cli.ts` and `src/tui/App.tsx` remain presentation adapters.

This plan intentionally does not reproduce Stack's broad Effect service graph. It adds one literal module around workflows that are already shared product concepts.

## Current State

Relevant files:

- `src/cli.ts` parses commands, but also transitions state, persists it, reconciles files, and compensates failed link operations.
- `src/tui/data.ts` mixes read-model construction with a second implementation of the same mutations.
- `src/tui/App.tsx` invokes the TUI-specific mutation wrappers and renders their results.
- `src/lib/manifest.ts` owns validated manifest/state persistence.
- `src/lib/reconcile.ts` owns global-store planning and application.
- `src/lib/linker.ts` owns project-link filesystem mechanics and immutable state transitions.

Recorded checksums:

```text
5fb7e6e3d42ac7f711cfb6f0c2046047ec24560a1fc81e8b87813886a1e6ffe4  src/cli.ts
b149f052a0a819c0aa1057536e5ffb5c1d81eebe3021f6f2d88b031475b65d1d  src/tui/data.ts
2762c063c76cb190bae5116f8ab37104a6cab970e67fc90fee2c1714932c447c  src/tui/App.tsx
c882fc832442c6da5952ac56d5a66c92052416cd50c62b91cfa858c4adcc482d  src/lib/reconcile.ts
d816aadf4969747c0bbd5f0126f61c98424bbc40630207c416d24ef8e0da74fe  src/lib/linker.ts
b2aff4e181e3e1a924e51d5585e5c3e9b7c0d8f8b70a04bfa9a8afc2ca775c02  src/lib/manifest.ts
```

CLI enablement currently owns transition, persistence, and reconciliation:

```ts
// src/cli.ts:320-330
for (const name of args) {
  if (!getSkill(manifest, name)) fail(`unknown skill: ${name}`);
  state = withSkillEnabled(state, name, cmd === "enable");
}
saveState(state);
runSync(manifest, state, flags);
```

The TUI repeats that workflow:

```ts
// src/tui/data.ts:142-160
export function setEnabled(name: string, enabled: boolean): ActionResult {
  const manifest = loadManifest();
  const state = loadState(manifest);
  const next = withSkillEnabled(state, name, enabled);
  saveState(next);
  return syncNow(manifest, next);
}
```

CLI linking owns compensation:

```ts
// src/cli.ts:364-378
const result = linkSkill(manifest, state, { ... });
state = result.state;
try {
  saveState(state);
} catch (error) {
  try {
    unlinkSkill(manifest, state, skill, result.link.project, { force: true });
  } catch {}
  throw error;
}
```

The TUI has a second copy at `src/tui/data.ts:185-201`. CLI unlinking separately implements state-first deletion with state rollback at `src/cli.ts:387-408`.

Applicable conventions:

- Domain values are plain aggregate Effect schemas; do not introduce `Schema.Class`, brands, or service classes for this work.
- State transitions are immutable and validated through functions in `src/domain/model.ts`.
- Filesystem mechanics remain in `src/lib/reconcile.ts` and `src/lib/linker.ts`; the new module orchestrates them rather than duplicating them.
- Errors are thrown from application/library code and formatted at the CLI or TUI boundary.
- Keep the implementation literal and small. One private state-change helper is preferable to a generic command bus or repository abstraction.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0, no TypeScript errors |
| Focused tests | `bun test src/lib/catalogActions.test.ts src/cli.test.ts src/tui/data.test.ts` | all focused tests pass |
| Full tests | `bun test` | all tests pass; baseline was 68 tests |
| Build | `bun run build:bin` | exit 0 and `dist/slinky` is compiled |

## Scope

**In scope** (the only source files to modify):

- `src/lib/catalogActions.ts` (create)
- `src/lib/catalogActions.test.ts` (create)
- `src/domain/model.ts` (type-side validation for immutable aggregate transitions only)
- `src/domain/model.test.ts` (transformed-value transition regression tests)
- `src/cli.ts`
- `src/cli.test.ts`
- `src/lib/linker.ts` (only the `linkedAt` schema-boundary correction described below)
- `src/lib/linker.test.ts` (one regression test for successful link construction)
- `src/tui/data.ts`
- `src/tui/App.tsx`
- `src/tui/data.test.ts` only if existing mutation tests need moving to `catalogActions.test.ts`
- `plans/README.md` for status only

**Out of scope**:

- `src/lib/reconcile.ts`: do not add selected-skill scoping in this plan.
- `src/lib/linker.ts`: except for encoding `linkedAt` correctly before `ProjectLink` decoding, do not redesign link deletion, quarantine, or race handling.
- `src/domain/model.ts`: do not change persisted schemas or encoded data shapes; only correct internal immutable transitions to validate already-decoded values through `Schema.toType`.
- `src/lib/manifest.ts`: do not redesign persistence or introduce dependency injection.
- Vendor/update/adopt/bootstrap/rehash workflows.
- TUI layout, project-only discovery, previews, and author grouping.
- A broad Effect `Context.Service` or `Layer` migration.
- New CLI commands, JSON output, `doctor`, or package/release changes.
- Transactional directory replacement or a persistent undo journal.

## Git Workflow

- The repository had no commits when this plan was authored. Before isolated execution, create an intentional baseline commit; do not let an executor guess what should be included.
- Suggested branch after a baseline exists: `advisor/001-catalog-actions`.
- Use a concise conventional commit such as `refactor: share catalog mutation workflows` if the eventual repository adopts conventional commits.
- Do not push or open a PR unless explicitly instructed.

## Steps

### Step 1: Add Characterization Tests At The Application Boundary

Create `src/lib/catalogActions.test.ts` using the isolated temporary `HOME` and `SLINKY_REPO` process pattern in `src/tui/data.test.ts`. Tests must invoke the public application functions, not CLI internals.

Cover these behaviors before switching callers:

1. Batch disable persists all selected names and reconciles once against a temporary home.
2. Batch enable removes those names from `disabledSkills` and materializes their global entries.
3. Unknown skill names fail before state or filesystem mutation.
4. Profile application persists the exact disabled complement and sets `activeProfile`.
5. Dry-run enable/disable and profile application return prospective reconciliation actions without changing state bytes or global stores. This intentionally corrects the current preview-persistence defect while establishing the shared boundary.
6. Successful link persists one `ProjectLink` and creates its targets.
7. Successful unlink removes its targets and persisted `ProjectLink`.
8. A failed state save after link creation compensates by removing only the paths created by that link. If this cannot be induced deterministically without changing an out-of-scope module, STOP and report rather than weakening the assertion.

Whole-catalog reconciliation is intentionally preserved. Assertions for a selected batch must allow messages for unrelated enabled skills whose global entries also need repair.

Use valid aggregate manifest/state JSON fixtures and a temporary home. Do not touch the developer's real `~/.agents`, `~/.claude`, config, or skills host.

**Verify**: `bun test src/lib/catalogActions.test.ts` should initially fail only because the module does not exist, then pass after Step 2.

### Step 2: Create The Shared Catalog Actions Module

Create `src/lib/catalogActions.ts` with this deliberately small public surface:

```ts
export interface ActionResult {
  readonly messages: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly dryRun: boolean;
}

export interface MutationOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export function setSkillsEnabled(
  names: ReadonlyArray<string>,
  enabled: boolean,
  options?: MutationOptions,
): ActionResult;

export function applyProfile(name: string, options?: MutationOptions): ActionResult;
export function linkProjectSkill(options: LinkOptions): { readonly link: ProjectLink };
export function unlinkProjectSkill(
  skill: string,
  project: string,
  options?: { readonly force?: boolean },
): { readonly link: ProjectLink; readonly warnings: ReadonlyArray<string> };
```

Implementation requirements:

- Load a fresh manifest and state inside each public workflow so long-running TUI sessions cannot persist transitions against stale state.
- Validate every selected skill against the freshly loaded manifest before changing anything.
- Use one private helper for the common state-change flow: derive the next state, call `planSync`, and either return a dry-run result without persistence or save once and call `apply` once.
- Preserve current whole-catalog reconciliation. Selected-skill scope is a separate finding.
- Combine planner warnings and apply skips in `warnings`.
- Keep output presentation out of this module. Messages should be stable operation descriptions; ANSI styling and `console.log` stay in adapters.
- `linkProjectSkill` must own the existing link-then-save compensation behavior currently duplicated in CLI and TUI.
- `unlinkProjectSkill` must own the existing prepare, save-next-state, apply deletion, and restore-previous-state-on-failure behavior from the CLI.
- Preserve current error propagation. Do not add a generic Result abstraction or Effect service.

The new link tests expose a pre-existing schema-boundary defect in `src/lib/linker.ts`: `ProjectLink` decoding expects the encoded timestamp string, but `linkedAt` currently receives `nowUtc()` as a `DateTime.Utc` value. Change only that assignment to pass the canonical string produced by `formatUtc(nowUtc())`, and add one direct successful-link regression test in `src/lib/linker.test.ts`. Do not broaden this plan to other timestamp call sites.

The immutable aggregate helpers in `src/domain/model.ts` currently call encoded-side decoders on values that are already decoded. Replace the private transition validators with `Schema.decodeUnknownSync(Schema.toType(Manifest))` and `Schema.decodeUnknownSync(Schema.toType(State))`. Loading persisted JSON must continue using the original schemas. With this correction, `linkSkill` must pass the decoded `link` value to `withProjectLink`; do not use casts to disguise encoded data as `ProjectLink`.

Move the existing batch mutation integration test from `src/tui/data.test.ts` into `src/lib/catalogActions.test.ts`; it no longer belongs to the TUI read-model test.

**Verify**: `bun test src/lib/catalogActions.test.ts` exits 0 with all application-boundary cases passing.

### Step 3: Convert The CLI Into A Presentation Adapter

Update `src/cli.ts`:

- Import the four shared workflows from `src/lib/catalogActions.ts`.
- Keep standalone `sync` using the existing `runSync`; it has no duplicate TUI workflow in this plan.
- Replace enable/disable transition, validation, save, and reconciliation code with one `setSkillsEnabled(args, cmd === "enable", { dryRun, force })` call.
- Replace profile mutation with `applyProfile(name, { dryRun, force })`. Profile listing remains local presentation logic.
- Replace direct `linkSkill` plus compensation with `linkProjectSkill`.
- Replace direct `prepareUnlink`, `saveState`, `applyUnlink`, and rollback with `unlinkProjectSkill`.
- Add one small CLI rendering helper for `ActionResult`: render dry-run messages as prospective actions, applied messages as completed actions, and print every warning.
- Preserve existing command names, flags, exit behavior, success wording, and link-target details except where dry-run state mutation is intentionally corrected.

Extend `src/cli.test.ts` with subprocess tests proving CLI enable/disable/profile/link/unlink route through the shared behavior. At minimum, assert dry-run state bytes remain unchanged and link/unlink update both filesystem and state.

**Verify**: `bun test src/cli.test.ts src/lib/catalogActions.test.ts` exits 0.

### Step 4: Convert The TUI Into A Presentation Adapter

Update `src/tui/data.ts` so it contains catalog/read-model operations only:

- Remove `ActionResult`, `syncNow`, `setEnabled`, `setSkillsEnabled`, `applyProfile`, and `doLink`.
- Remove mutation-only imports from manifest, reconcile, and linker modules.
- Keep catalog loading, project discovery, diffing, descriptions, and file-preview readers unchanged.

Update `src/tui/App.tsx`:

- Import `ActionResult`, `setSkillsEnabled`, `applyProfile`, and `linkProjectSkill` directly from `src/lib/catalogActions.ts`.
- Replace single-skill toggles with `setSkillsEnabled([current.name], ...)`.
- Keep author toggles using the same `setSkillsEnabled` call.
- Adapt the link flow to catch errors from `linkProjectSkill` and report them through the existing notification UI.
- Do not add unlink UI in this plan; the shared unlink action is for CLI ownership and future TUI use.
- Preserve existing warning display behavior. A persistent multi-warning result view is a separate finding.

Remove or relocate mutation tests from `src/tui/data.test.ts`; retain all project-context, discovery, and preview tests.

**Verify**: `bun test src/tui/data.test.ts src/lib/catalogActions.test.ts && bun run typecheck` exits 0.

### Step 5: Prove The Old Orchestration Is Gone

Run these searches:

```bash
rg -n 'withSkillEnabled|withProfile|linkSkill|prepareUnlink|applyUnlink' src/cli.ts src/tui/data.ts
rg -n 'saveState\(' src/tui/data.ts
```

Both commands must return no matches. `src/cli.ts` may still use `saveState` for unrelated out-of-scope workflows only if a cited call is not part of enablement, profiles, linking, or unlinking.

Run the complete verification suite.

**Verify**:

```bash
bun run typecheck
bun test
bun run build:bin
```

Expected: all commands exit 0; the test count is greater than the 68-test baseline.

## Test Plan

New tests in `src/lib/catalogActions.test.ts`:

- Batch enable and disable.
- Up-front unknown-name validation.
- Exact-set profile application.
- Byte-for-byte non-mutating dry runs.
- Link success and persisted state.
- Unlink success and persisted state.
- Link compensation after persistence failure, or a STOP report if deterministic fault injection requires an out-of-scope seam.

CLI subprocess coverage in `src/cli.test.ts`:

- `enable --dry-run` and `profile apply --dry-run` leave state unchanged.
- Applied enable/disable persists and reconciles.
- Link followed by unlink leaves no recorded link or project target.

Existing structural examples:

- `src/tui/data.test.ts` for isolated `HOME`/`SLINKY_REPO` child processes.
- `src/lib/linker.test.ts` for safe project-link filesystem fixtures.
- `src/lib/manifest.test.ts` for persisted aggregate schema behavior.

Verification: `bun test` passes with more than 68 tests.

## Done Criteria

- [ ] `src/lib/catalogActions.ts` exclusively owns enablement, profile-apply, link, and unlink orchestration.
- [ ] CLI and TUI mutation adapters invoke the same application functions.
- [ ] Dry-run enable/disable/profile operations do not alter state or global stores.
- [ ] `src/tui/data.ts` contains no state persistence or reconciliation calls.
- [ ] The old mutation imports/search patterns are absent from `src/cli.ts` and `src/tui/data.ts`.
- [ ] Link and unlink preserve current compensation behavior.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun test` exits 0 with more than 68 tests.
- [ ] `bun run build:bin` exits 0.
- [ ] No source files outside the in-scope list are modified.
- [ ] `plans/README.md` marks Plan 001 DONE or BLOCKED with a reason.

## STOP Conditions

Stop and report rather than improvising if:

- Any recorded checksum differs and the relevant mutation code no longer matches the Current State excerpts.
- An initial Git baseline still does not exist when isolated-worktree execution is requested.
- Link compensation cannot be tested without changing `src/lib/manifest.ts`, making additional changes in `src/lib/linker.ts`, or introducing a broad dependency-injection framework.
- The `linkedAt` correction requires any change beyond converting `nowUtc()` to its canonical encoded string or requires changing the `ProjectLink` schema.
- Correcting immutable transitions requires changing any persisted schema, encoded JSON shape, or public function signature rather than only switching private transition validation to `Schema.toType`.
- Consolidation requires changing reconciliation scope, filesystem replacement semantics, or project-link schema.
- Existing CLI and TUI behavior conflict in a way not explicitly resolved by this plan, other than the intentional dry-run correction.
- Any verification command fails twice after a reasonable correction attempt.

## Maintenance Notes

- Future selected-skill reconciliation should be added inside `catalogActions.ts`, not separately in CLI and TUI.
- Transactional directory replacement belongs below this layer in `reconcile.ts` and `linker.ts`.
- If a future TUI unlink affordance is added, it must call `unlinkProjectSkill`; do not reimplement rollback in `App.tsx` or `data.ts`.
- Reviewers should scrutinize dry-run persistence, compensation ordering, and whether errors retain enough path/operation context.
- The new application boundary is intentionally concrete. Add dependency injection only when a real second adapter or deterministic failure test requires it.
