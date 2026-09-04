import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ExternalToolError, OperationFailed } from "../domain/model.ts";

/** Run Git without inheriting repository variables from the caller. */
export const tryGit = Effect.fn("Git.try")(function* (repo: string, args: ReadonlyArray<string>) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"]) {
    delete env[name];
  }
  const result = yield* Effect.sync(() => spawnSync("git", ["--literal-pathspecs", ...args], { cwd: repo, encoding: "utf8", env }));
  if (result.error) return yield* Effect.fail(new ExternalToolError({ tool: "git", message: result.error.message }));
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
});

export const runGit = Effect.fn("Git.run")(function* (repo: string, args: ReadonlyArray<string>) {
  const result = yield* tryGit(repo, args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return yield* Effect.fail(new ExternalToolError({ tool: "git", message: detail || `git exited with ${result.status ?? "unknown"}` }));
  }
  return { stdout: result.stdout, stderr: result.stderr };
});

export const assertGitRoot = Effect.fn("Git.assertRoot")(function* (repo: string) {
  const topLevel = yield* runGit(repo, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(topLevel.stdout.trim()) !== realpathSync(repo)) {
    return yield* Effect.fail(new OperationFailed({ message: `skills host must be a Git repository root: ${repo}` }));
  }
});

export const requireCleanWorktree = Effect.fn("Git.requireCleanWorktree")(function* (repo: string) {
  const status = yield* runGit(repo, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.stdout.trim()) {
    return yield* Effect.fail(new OperationFailed({ message: "skills host worktree must be clean; save, commit, or remove local changes first" }));
  }
});

export const requireUpstream = Effect.fn("Git.requireUpstream")(function* (repo: string) {
  const branch = (yield* runGit(repo, ["branch", "--show-current"])).stdout.trim();
  if (!branch) return yield* Effect.fail(new OperationFailed({ message: "skills host is on a detached HEAD; check out a branch first" }));
  const upstream = yield* runGit(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.mapError(() => new OperationFailed({ message: `branch ${branch} has no upstream; configure one with git push --set-upstream` })),
  );
  const remote = (yield* runGit(repo, ["config", "--get", `branch.${branch}.remote`])).stdout.trim();
  const mergeRef = (yield* runGit(repo, ["config", "--get", `branch.${branch}.merge`])).stdout.trim();
  return { upstream, remote, mergeRef };
});

/** Scoped detached worktree at a commit; removed (worktree and directory) on release. */
export const temporaryWorktree = Effect.fn("Git.temporaryWorktree")(function* (repo: string, prefix: string, commit: string) {
  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      yield* runGit(repo, ["worktree", "add", "--detach", directory, commit]).pipe(Effect.onError(() => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))));
      return directory;
    }),
    (directory) =>
      Effect.gen(function* () {
        yield* runGit(repo, ["worktree", "remove", "--force", directory]).pipe(Effect.ignore);
        yield* Effect.sync(() => rmSync(directory, { recursive: true, force: true }));
      }),
  );
});

/** Paths git reports as conflicted in `merge-tree --write-tree` output, which follows the tree OID. */
export function conflictedPaths(mergeTreeStdout: string): ReadonlyArray<string> {
  const lines = mergeTreeStdout.split("\n").slice(1);
  const end = lines.indexOf("");
  const entries = end === -1 ? lines : lines.slice(0, end);
  return [...new Set(entries.map((line) => line.split("\t")[1]).filter((path): path is string => path !== undefined))];
}
