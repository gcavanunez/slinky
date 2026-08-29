/** @jsxImportSource @opentui/react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

process.env.HOME = home;
process.env.SLINKY_REPO = host;

const { act } = await import("react");
const { testRender } = await import("@opentui/react/test-utils");
const { App } = await import("./App.tsx");

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
async function mount() {
  const setup = await testRender(<App />, size);
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
afterAll(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

const size = { width: 120, height: 30 } as const;

test("mounts and renders the catalog chrome", async () => {
  const setup = await mount();
  try {
    const frame = await setup.waitForFrame((value) => value.includes("slinky"));
    expect(frame).toContain("slinky");
    expect(frame).toContain("available here");
    expect(frame).toContain("all skills");
  } finally {
    setup.renderer.destroy();
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
    setup.renderer.destroy();
  }
});

test("? opens help and esc closes it", async () => {
  const setup = await mount();
  try {
    await setup.waitForFrame((value) => value.includes("slinky"));

    await input(() => setup.mockInput.pressKey("?"));
    const help = await setup.waitForFrame((value) => value.includes("focus the previous or next panel"));
    expect(help).toContain("help");

    await input(async () => {
      setup.mockInput.pressEscape();
      // A lone ESC is a sequence prefix; the parser holds it until it can rule
      // out a longer escape sequence.
      await Bun.sleep(60);
    });
    const closed = await setup.waitForFrame((value) => !value.includes("focus the previous or next panel"));
    expect(closed).not.toContain("focus the previous or next panel");
  } finally {
    setup.renderer.destroy();
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
    setup.renderer.destroy();
  }
});
