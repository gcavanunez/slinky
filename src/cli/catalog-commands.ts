import { join, resolve } from "node:path";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { classifyPlacement, inspectCatalogEntry } from "../domain/catalog-inspection.ts";
import type { CatalogLiveStatus, LiveEntry, VendorHashState } from "../domain/catalog-inspection.ts";
import { getActiveProfile, isSkillEnabled } from "../domain/model.ts";
import type { Manifest, State } from "../domain/model.ts";
import { claudeRelTarget } from "../domain/reconcile-plan.ts";
import { findUnindexedSkills } from "../lib/adopt.ts";
import { applyProfile, setSkillsEnabled } from "../lib/catalog-actions.ts";
import { verifyCatalog } from "../lib/convergence.ts";
import { contentHash } from "../lib/hash.ts";
import { HostRepo, Paths } from "../lib/paths.ts";
import { observe } from "../lib/reconcile.ts";
import { c, pad, renderAction, renderConvergenceEvent, stripAnsi } from "./render.ts";
import { dryRunFlag, forceFlag, loadHostState, skillsArg, withRepo } from "./shared.ts";

const cmdStatus = Effect.fn("Cli.status")(function* (manifest: Manifest, state: State) {
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;
  const obs = yield* observe();
  const nameW = Math.max(4, ...Object.keys(manifest.skills).map((n) => n.length)) + 2;
  console.log(c.dim(`host: ${repo}\n`));
  console.log(c.bold(`${pad("NAME", nameW)}${pad("ORIGIN", 8)}${pad("ENABLED", 9)}${pad("LIVE", 10)}CLAUDE`));
  for (const [name, meta] of Object.entries(manifest.skills)) {
    const enabled = isSkillEnabled(manifest, state, name);
    const live: LiveEntry = Object.hasOwn(obs.agents, name) ? obs.agents[name]! : { kind: "missing" };
    const claudeEntry: LiveEntry = Object.hasOwn(obs.claude, name) ? obs.claude[name]! : { kind: "missing" };
    const claude = classifyPlacement(claudeEntry, resolve(paths.claudeSkills, claudeRelTarget(name))) === "expected-symlink" ? "yes" : c.dim("-");
    const vendorHash: VendorHashState =
      enabled && meta.origin === "vendor" && live.kind === "dir"
        ? { kind: "verified", matches: contentHash(join(paths.agentsSkills, name)) === meta.contentHash }
        : { kind: "pending" };
    const inspection = inspectCatalogEntry({ origin: meta.origin, enabled, live, expectedTarget: resolve(repo, meta.path), vendorHash });
    const labels = {
      ok: c.green("ok"),
      drift: c.yellow("drift"),
      missing: c.red(live.kind),
      off: c.dim("-"),
      stale: c.yellow(live.kind),
      checking: c.dim("checking"),
      unowned: c.yellow("unowned"),
    } satisfies Record<CatalogLiveStatus, string>;
    const liveLabel = labels[inspection.status];

    console.log(
      `${pad(name, nameW)}${pad(meta.origin, 8)}${pad(enabled ? "on" : c.dim("off"), enabled ? 9 : 9 + 9)}${pad(liveLabel, 10 + liveLabel.length - stripAnsi(liveLabel).length)}${claude}`,
    );
  }
  const foreign = Object.keys(obs.agents).filter((n) => !(n in manifest.skills));
  if (foreign.length > 0) console.log(c.yellow(`\nforeign entries in ~/.agents/skills: ${foreign.join(", ")}`));
  const unindexed = findUnindexedSkills(manifest, repo);
  if (unindexed.length > 0) {
    console.log(c.yellow("\nunindexed skills in host:"));
    for (const skill of unindexed) console.log(`  ${pad(skill.name, nameW)}${skill.path}`);
  }
});

export const cmdVerify = Effect.fn("Cli.verify")(function* () {
  yield* verifyCatalog(renderConvergenceEvent);
});

export const statusCommand = Command.make("status", {}, () =>
  withRepo(
    Effect.gen(function* () {
      const { manifest, state } = yield* loadHostState;
      yield* cmdStatus(manifest, state);
    }),
  ),
).pipe(Command.withDescription("Catalog: origin, enabled, live state, claude link"));

const makeToggleCommand = (name: "enable" | "disable", description: string) =>
  Command.make(name, { skills: skillsArg, dryRun: dryRunFlag, force: forceFlag }, ({ skills, dryRun, force }) =>
    withRepo(
      Effect.gen(function* () {
        renderAction(yield* setSkillsEnabled(skills, name === "enable", { dryRun, force }));
      }),
    ),
  ).pipe(Command.withDescription(description));

export const enableCommand = makeToggleCommand("enable", "Enable skill(s) globally and sync");
export const disableCommand = makeToggleCommand("disable", "Disable skill(s) globally and sync");

const profileList = withRepo(
  Effect.gen(function* () {
    const { manifest, state } = yield* loadHostState;
    const entries = Object.entries(manifest.profiles);
    if (entries.length === 0) console.log(c.dim("no profiles defined (edit skills.manifest.json)"));
    for (const [name, skills] of entries) {
      const active = getActiveProfile(manifest, state) === name ? c.green(" (active)") : "";
      console.log(`${c.bold(name)}${active}: ${skills.join(", ")}`);
    }
  }),
);

const profileListCommand = Command.make("list", {}, () => profileList).pipe(Command.withDescription("List profiles"));

const profileApplyCommand = Command.make(
  "apply",
  {
    name: Argument.string("name"),
    dryRun: dryRunFlag,
    force: forceFlag,
  },
  ({ name, dryRun, force }) =>
    withRepo(
      Effect.gen(function* () {
        renderAction(yield* applyProfile(name, { dryRun, force }));
      }),
    ),
).pipe(Command.withDescription("Enable exactly the profile's skills"));

export const profileCommand = Command.make("profile", {}, () => profileList).pipe(
  Command.withDescription("List profiles or apply one"),
  Command.withSubcommands([profileListCommand, profileApplyCommand]),
);

export const verifyCommand = Command.make("verify", {}, () =>
  withRepo(
    Effect.gen(function* () {
      yield* cmdVerify();
    }),
  ),
).pipe(Command.withDescription("Hash-check every skill against the manifest"));
