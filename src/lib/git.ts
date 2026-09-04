import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ExternalToolError, OperationFailed } from "../domain/model.ts";

export interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRunner = (repo: string, args: ReadonlyArray<string>) => Effect.Effect<GitResult, ExternalToolError>;

/** Git must see only the target repo, not GIT_DIR and friends inherited from a hook or an editor. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"]) {
    delete env[name];
  }
  return env;
}

/** Run Git without inheriting repository variables from the caller. */
export const tryGit: GitRunner = Effect.fn("Git.try")(function* (repo: string, args: ReadonlyArray<string>) {
  const result = yield* Effect.sync(() => spawnSync("git", ["--literal-pathspecs", ...args], { cwd: repo, encoding: "utf8", env: gitEnv() }));
  if (result.error) return yield* Effect.fail(new ExternalToolError({ tool: "git", message: result.error.message }));
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
});

/** Same as tryGit but yields to the event loop while git runs, so a renderer keeps painting during a fetch. */
export const tryGitAsync: GitRunner = Effect.fn("Git.tryAsync")(function* (repo: string, args: ReadonlyArray<string>) {
  return yield* Effect.callback<GitResult, ExternalToolError>((resume) => {
    const child = spawn("git", ["--literal-pathspecs", ...args], { cwd: repo, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => resume(Effect.fail(new ExternalToolError({ tool: "git", message: error.message }))));
    child.on("close", (status) => resume(Effect.succeed({ status, stdout, stderr })));
    return Effect.sync(() => child.kill());
  });
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

export type UpstreamComparison =
  | { readonly kind: "no-upstream" }
  | { readonly kind: "unreachable"; readonly upstream: string; readonly detail: string }
  | { readonly kind: "compared"; readonly upstream: string; readonly ahead: number; readonly behind: number };

/**
 * Fetch the tracking branch and count commits either side of HEAD. A repo
 * without a branch or upstream is not an error here; callers decide whether
 * that matters. A failed fetch (offline, auth) reports as unreachable.
 */
export const compareWithUpstream = Effect.fn("Git.compareWithUpstream")(function* (repo: string, git: GitRunner = tryGit) {
  const run = Effect.fn("Git.compareWithUpstream.run")(function* (args: ReadonlyArray<string>) {
    const result = yield* git(repo, args);
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      return yield* Effect.fail(new ExternalToolError({ tool: "git", message: detail || `git exited with ${result.status ?? "unknown"}` }));
    }
    return result;
  });
  const branch = yield* git(repo, ["branch", "--show-current"]);
  const none: UpstreamComparison = { kind: "no-upstream" };
  if (branch.status !== 0 || !branch.stdout.trim()) return none;
  const upstreamRef = yield* git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstreamRef.status !== 0) return none;
  const upstream = upstreamRef.stdout.trim();
  const name = branch.stdout.trim();
  const remote = (yield* run(["config", "--get", `branch.${name}.remote`])).stdout.trim();
  const mergeRef = (yield* run(["config", "--get", `branch.${name}.merge`])).stdout.trim();
  const fetched = yield* git(repo, ["fetch", "--quiet", remote, mergeRef]);
  if (fetched.status !== 0) {
    const unreachable: UpstreamComparison = {
      kind: "unreachable",
      upstream,
      detail: (fetched.stderr || fetched.stdout).trim() || `git fetch exited with ${fetched.status ?? "unknown"}`,
    };
    return unreachable;
  }
  const counts = (yield* run(["rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"])).stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(counts[0] ?? "", 10);
  const behind = Number.parseInt(counts[1] ?? "", 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return yield* Effect.fail(new OperationFailed({ message: `could not compare HEAD with ${upstream}` }));
  }
  const compared: UpstreamComparison = { kind: "compared", upstream, ahead, behind };
  return compared;
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
