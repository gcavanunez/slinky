/** @jsxImportSource @opentui/react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppProps } from "./app.tsx";
import type { UpstreamStatus } from "../lib/update.ts";
import type { RunResult } from "./runtime.ts";

// Paths/HostRepo read these while the Effect layer builds, which happens on the
// first runSync inside App. Set them before importing anything that touches the
// module-level TUI runtime.
const root = mkdtempSync(join(tmpdir(), "slinky-tui-"));
const host = join(root, "host");
const home = join(root, "home");
const project = join(root, "project");

mkdirSync(join(host, ".local"), { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
for (const name of ["alpha", "beta"]) {
  mkdirSync(join(host, "skills", name), { recursive: true });
  writeFileSync(join(host, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture skill.\n---\n\n# ${name}\n\n## Usage\n\nRun it.\n`);
}
writeFileSync(
  join(host, "skills.manifest.json"),
  `${JSON.stringify({
    version: 1,
    skills: {
      alpha: { origin: "local", path: "skills/alpha", contentHash: "a".repeat(64) },
      beta: { origin: "local", path: "skills/beta", contentHash: "b".repeat(64) },
    },
    profiles: { focus: ["alpha"] },
  })}\n`,
);
writeFileSync(join(host, ".local", "state.json"), `${JSON.stringify({ version: 1, disabledSkills: [], activeProfile: null, projectLinks: [], recentProjects: [] }, null, 2)}\n`);

// The host tracks a bare remote that is one commit ahead, so the launch-time
// store check has something to report and S has something to pull.
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};
const remote = join(root, "remote.git");
const publisher = join(root, "publisher");
writeFileSync(join(host, ".gitignore"), ".local/\n");
git(host, "init", "-q", "-b", "main");
git(host, "add", ".");
git(host, "commit", "-qm", "init");
git(root, "init", "-q", "--bare", remote);
git(host, "remote", "add", "origin", remote);
git(host, "push", "-qu", "origin", "main");
git(root, "clone", "-q", remote, publisher);
writeFileSync(join(publisher, "README.md"), "# catalog\n");
git(publisher, "add", ".");
git(publisher, "commit", "-qm", "add readme");
git(publisher, "push", "-q");

process.env.HOME = home;
process.env.SLINKY_REPO = host;

const { act } = await import("react");
const { createTestRenderer } = await import("@opentui/core/testing");
const { createDefaultOpenTuiKeymap } = await import("@opentui/keymap/opentui");
const { KeymapProvider } = await import("@opentui/keymap/react");
const { createRoot } = await import("@opentui/react");
const { App } = await import("./app.tsx");
const { rendererOptions } = await import("./index.tsx");
const { runtime } = await import("./runtime.ts");

/** Stand in for the real service so tests never touch the host clipboard. */
const clipboard = {
  writeText: async () => ({ host: { status: "written" }, terminal: { status: "not-attempted", capability: "unknown" } }) as const,
};

/**
 * mockInput drives the real parser, so the resulting KeyEvent lands outside
 * React's act scope. Flush the state update it triggers before asserting.
 */
async function input(drive: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await drive();
  });
}

/**
 * Mount and let the post-mount work settle. App verifies vendor hashes from a
 * zero-delay timer, so that state update also has to land inside act.
 */
async function mount(props: Omit<AppProps, "clipboard"> = {}) {
  let root: ReturnType<typeof createRoot> | null = null;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true, writable: true });
  const setup = await createTestRenderer({
    ...rendererOptions,
    ...size,
    onDestroy() {
      root = null;
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: false, configurable: true, writable: true });
    },
  });
  const keymap = createDefaultOpenTuiKeymap(setup.renderer);
  root = createRoot(setup.renderer);
  act(() => {
    root?.render(
      <KeymapProvider keymap={keymap}>
        <App clipboard={clipboard} {...props} />
      </KeymapProvider>,
    );
  });
  await act(async () => {
    await Bun.sleep(10);
  });
  return setup;
}

let cwd: string;
beforeAll(() => {
  cwd = process.cwd();
  process.chdir(project);
});
afterAll(async () => {
  process.chdir(cwd);
  await runtime.dispose();
  rmSync(root, { recursive: true, force: true });
});

const size = { width: 120, height: 30 } as const;

async function closeOverlay(setup: Awaited<ReturnType<typeof mount>>): Promise<void> {
  await input(async () => {
    setup.mockInput.pressEscape();
    await Bun.sleep(60);
  });
}

function destroy(setup: Awaited<ReturnType<typeof mount>>): void {
  act(() => setup.renderer.destroy());
}

function deferredUpstream() {
  return Promise.withResolvers<RunResult<ReadonlyArray<UpstreamStatus>>>();
}

test("mounts and renders the catalog chrome", async () => {
  const setup = await mount();
  try {
    const frame = await setup.waitForFrame((value) => value.includes("slinky"));
    expect(frame).toContain("slinky");
    expect(frame).toContain("AVAILABLE HERE");
    expect(frame).toContain("ALL SKILLS");
  } finally {
    destroy(setup);
  }
});

test("the all-skills view lists every indexed skill and previews its document", async () => {
  const setup = await mount();
  try {
    await setup.waitForFrame((value) => value.includes("slinky"));

    await input(() => setup.mockInput.pressKey("2"));
    const listed = await setup.waitForFrame((value) => value.includes("alpha") && value.includes("beta"));
    expect(listed).toContain("alpha");
    expect(listed).toContain("beta");

    // The preview pane renders the selected skill's SKILL.md through <markdown>.
    const preview = await setup.waitForFrame((value) => value.includes("Usage"));
    expect(preview).toContain("Usage");
  } finally {
    destroy(setup);
  }
});

test("? opens help and esc closes it", async () => {
  const setup = await mount();
  try {
    await setup.waitForFrame((value) => value.includes("slinky"));

    await input(() => setup.mockInput.pressKey("?"));
    const help = await setup.waitForFrame((value) => value.includes("focus the previous or next panel"));
    expect(help).toContain("Help");

    await input(async () => {
      setup.mockInput.pressEscape();
      // A lone ESC is a sequence prefix; the parser holds it until it can rule
      // out a longer escape sequence.
      await Bun.sleep(60);
    });
    const closed = await setup.waitForFrame((value) => !value.includes("focus the previous or next panel"));
    expect(closed).not.toContain("focus the previous or next panel");
  } finally {
    destroy(setup);
  }
});

test("overlays are exclusive and render the payload captured when opened", async () => {
  const gamma = join(host, "skills", "gamma");
  mkdirSync(gamma, { recursive: true });
  writeFileSync(join(gamma, "SKILL.md"), "---\nname: gamma\ndescription: gamma unindexed fixture skill.\n---\n\n# gamma\n");
  const setup = await mount();
  try {
    await setup.waitForFrame((value) => value.includes("slinky"));
    await input(() => setup.mockInput.pressKey("2"));

    await input(() => setup.mockInput.pressKey("i"));
    const detail = await setup.waitForFrame((value) => value.includes("gamma unindexed fixture skill."));
    expect(detail).toContain("gamma");
    expect(detail).toContain("unindexed");

    // List bindings are inactive while an overlay owns the interaction state.
    await input(() => setup.mockInput.pressKey("p"));
    expect(await setup.waitForFrame((value) => value.includes("gamma unindexed fixture skill."))).not.toContain("Applying a profile");
    await closeOverlay(setup);

    await input(() => setup.mockInput.pressKey("a"));
    const index = await setup.waitForFrame((value) => value.includes("Index gamma"));
    expect(index).toContain("source: skills/gamma");
    await closeOverlay(setup);

    // gamma -> "local" heading -> alpha
    await input(() => setup.mockInput.pressKey("j"));
    await input(() => setup.mockInput.pressKey("j"));

    await input(() => setup.mockInput.pressKey("d"));
    const diff = await setup.waitForFrame((value) => value.includes("Diff alpha"));
    expect(diff).toContain("local skill: lives in the repo, nothing to diff");
    await closeOverlay(setup);

    await input(() => setup.mockInput.pressKey("l", { shift: true }));
    const link = await setup.waitForFrame((value) => value.includes("Link alpha"));
    expect(link).toContain("Project directory");
    await closeOverlay(setup);

    await input(() => setup.mockInput.pressKey("p"));
    const profiles = await setup.waitForFrame((value) => value.includes("Applying a profile disables"));
    expect(profiles).toContain("focus");
    await closeOverlay(setup);
    expect(await setup.waitForFrame((value) => !value.includes("Applying a profile disables"))).toContain("alpha");
  } finally {
    destroy(setup);
    rmSync(gamma, { recursive: true, force: true });
  }
});

test("a stale upstream check cannot overwrite a newer result", async () => {
  const requests = [deferredUpstream(), deferredUpstream()];
  const signals: AbortSignal[] = [];
  let requestIndex = 0;
  const setup = await mount({
    checkForUpstream: (_manifest, signal) => {
      signals.push(signal);
      return requests[requestIndex++]!.promise;
    },
  });
  try {
    await setup.waitForFrame((value) => value.includes("slinky"));
    await input(() => setup.mockInput.pressKey("2"));
    await input(() => setup.mockInput.pressKey("u"));
    await input(() => setup.mockInput.pressKey("u"));
    expect(signals[0]?.aborted).toBe(true);

    await act(async () => {
      requests[1]!.resolve({ ok: true, value: [{ name: "alpha", state: "update" }] });
      await Bun.sleep(0);
    });
    const updated = await setup.waitForFrame((value) => value.includes("upstream: 1 update(s), 0 gone"));
    expect(updated).not.toContain("upstream: 0 update(s), 1 gone");

    await act(async () => {
      requests[0]!.resolve({ ok: true, value: [{ name: "alpha", state: "gone" }] });
      await Bun.sleep(10);
    });
    expect(setup.captureCharFrame()).toContain("upstream: 1 update(s), 0 gone");
  } finally {
    destroy(setup);
  }
});

test("unmount aborts an in-flight upstream check", async () => {
  const request = deferredUpstream();
  let signal: AbortSignal | undefined;
  const setup = await mount({
    checkForUpstream: (_manifest, currentSignal) => {
      signal = currentSignal;
      return request.promise;
    },
  });
  await setup.waitForFrame((value) => value.includes("slinky"));
  await input(() => setup.mockInput.pressKey("u"));
  expect(signal?.aborted).toBe(false);

  destroy(setup);
  expect(signal?.aborted).toBe(true);
  request.resolve({ ok: true, value: [{ name: "alpha", state: "gone" }] });
  await Bun.sleep(10);
  expect(setup.renderer.isDestroyed).toBe(true);
});

test("catalog refresh aborts and invalidates an in-flight upstream check", async () => {
  const request = deferredUpstream();
  let signal: AbortSignal | undefined;
  const setup = await mount({
    checkForUpstream: (_manifest, currentSignal) => {
      signal = currentSignal;
      return request.promise;
    },
  });
  try {
    await setup.waitForFrame((value) => value.includes("slinky"));
    await input(() => setup.mockInput.pressKey("u"));
    expect(signal?.aborted).toBe(false);

    await input(() => setup.mockInput.pressKey("r"));
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      request.resolve({ ok: true, value: [{ name: "alpha", state: "gone" }] });
      await Bun.sleep(10);
    });
    expect(setup.captureCharFrame()).not.toContain("upstream: 0 update(s), 1 gone");
  } finally {
    destroy(setup);
  }
});

test("clicking a pane does not hand key bindings to a focused renderable", async () => {
  const setup = await mount();
  try {
    await setup.waitForFrame((value) => value.includes("slinky"));
    await input(() => setup.mockInput.pressKey("2"));
    await setup.waitForFrame((value) => value.includes("alpha"));

    // Inside the document pane, whose ScrollBox is focusable by default.
    await input(() => setup.mockMouse.click(90, 10));

    // With autofocus on, the ScrollBox would take focus here and then apply its
    // own arrow/page/home bindings on top of App's, scrolling twice per press.
    expect(setup.renderer.currentFocusedRenderable).toBeNull();
  } finally {
    destroy(setup);
  }
});

test("/ filters the catalog down to matching skills", async () => {
  const setup = await mount();
  try {
    await setup.waitForFrame((value) => value.includes("slinky"));
    await input(() => setup.mockInput.pressKey("2"));
    await setup.waitForFrame((value) => value.includes("beta"));

    await input(() => setup.mockInput.pressKey("/"));
    await input(() => setup.mockInput.typeText("alph"));

    const filtered = await setup.waitForFrame((value) => value.includes("1 match"));
    expect(filtered).toContain("alpha");
    expect(filtered).not.toContain("beta");
  } finally {
    destroy(setup);
  }
});

test("Ctrl+C does not quit while filter input is active", async () => {
  const setup = await mount();
  try {
    await setup.waitForFrame((value) => value.includes("slinky"));
    await input(() => setup.mockInput.pressKey("2"));
    await input(() => setup.mockInput.pressKey("/"));
    await input(() => setup.mockInput.typeText("alph"));
    await setup.waitForFrame((value) => value.includes("1 match"));

    await input(() => setup.mockInput.pressCtrlC());

    expect(setup.renderer.isDestroyed).toBe(false);
    expect(await setup.waitForFrame((value) => value.includes("1 match"))).toContain("alpha");
  } finally {
    destroy(setup);
  }
});

test("keymap routes list movement and the gg sequence", async () => {
  const setup = await mount();
  try {
    await setup.waitForFrame((value) => value.includes("slinky"));
    await input(() => setup.mockInput.pressKey("2"));
    await input(() => setup.mockInput.pressKey("j"));
    await input(() => setup.mockInput.pressKey("i"));
    expect(await setup.waitForFrame((value) => value.includes("beta fixture skill."))).toContain("beta fixture skill.");

    await input(async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(60);
    });
    await setup.waitForFrame((value) => !value.includes("beta fixture skill."));
    await input(async () => {
      setup.mockInput.pressKey("g");
      await Bun.sleep(550);
    });
    await input(() => setup.mockInput.pressKey("i"));
    expect(await setup.waitForFrame((value) => value.includes("beta fixture skill."))).toContain("beta fixture skill.");
    await input(async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(60);
    });
    await setup.waitForFrame((value) => !value.includes("beta fixture skill."));
    await input(() => {
      setup.mockInput.pressKey("g");
      setup.mockInput.pressKey("j");
    });
    await input(() => setup.mockInput.pressKey("i"));
    expect(await setup.waitForFrame((value) => value.includes("beta fixture skill."))).toContain("beta fixture skill.");
    await input(async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(60);
    });
    await setup.waitForFrame((value) => !value.includes("beta fixture skill."));
    // gg lands on the group heading; the first skill is one row below.
    await input(() => {
      setup.mockInput.pressKey("g");
      setup.mockInput.pressKey("g");
    });
    await input(() => setup.mockInput.pressKey("j"));
    await input(() => setup.mockInput.pressKey("i"));
    expect(await setup.waitForFrame((value) => value.includes("alpha fixture skill."))).toContain("alpha fixture skill.");
  } finally {
    destroy(setup);
  }
});

test("groups fold from their heading and space toggles the whole set", async () => {
  const setup = await mount();
  try {
    await setup.waitForFrame((value) => value.includes("slinky"));
    await input(() => setup.mockInput.pressKey("2"));
    await setup.waitForFrame((value) => value.includes("▾ local"));

    // h from a skill jumps to its heading; z folds it and the skills disappear.
    await input(() => setup.mockInput.pressKey("h"));
    await input(() => setup.mockInput.pressKey("z"));
    const folded = await setup.waitForFrame((value) => value.includes("▸ local"));
    expect(folded).not.toContain("alpha");

    // l on a folded heading opens it again without leaving the pane.
    await input(() => setup.mockInput.pressKey("l"));
    expect(await setup.waitForFrame((value) => value.includes("▾ local"))).toContain("alpha");

    // space on the heading disables every skill in the group.
    await input(() => setup.mockInput.pressKey(" "));
    const off = await setup.waitForFrame((value) => value.includes("disabled local"));
    expect(off).toContain("0/2");
    await input(() => setup.mockInput.pressKey(" "));
    expect(await setup.waitForFrame((value) => value.includes("enabled local"))).toContain("2/2");
  } finally {
    destroy(setup);
  }
});

test("launch reports unpulled store commits and S syncs them down", async () => {
  const setup = await mount();
  try {
    // The store check is a background git fetch resolving outside act; give it
    // real time inside act so its state update is flushed.
    const settle = () => act(() => Bun.sleep(400));
    await settle();
    const behind = await setup.waitForFrame((value) => value.includes("⇣ 1 to pull"));
    expect(behind).toContain("S sync");

    await input(() => setup.mockInput.pressKey("S"));
    await settle();
    const done = await setup.waitForFrame((value) => value.includes("Sync") && value.includes("done"));
    expect(done).toContain("esc close");

    // The log is longer than the modal: g jumps to the top, G back to the tail.
    await input(() => setup.mockInput.pressKey("g"));
    expect(await setup.waitForFrame((value) => value.includes("done · 1-"))).toContain("SAVE");
    await input(() => setup.mockInput.pressKey("G"));
    expect(await setup.waitForFrame((value) => !value.includes("done · 1-"))).toContain("RESTORE");
    await closeOverlay(setup);

    await settle();
    expect(await setup.waitForFrame((value) => !value.includes("to pull"))).not.toContain("⇣");
    expect(Bun.spawnSync(["git", "rev-list", "--count", "HEAD..origin/main"], { cwd: host }).stdout.toString().trim()).toBe("0");
  } finally {
    destroy(setup);
  }
});
