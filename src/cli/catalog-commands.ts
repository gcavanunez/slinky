import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { classifyPlacement } from "../domain/catalog-inspection.ts";
import type { CatalogLiveStatus, LiveEntry } from "../domain/catalog-inspection.ts";
import { getActiveProfile, getProfileOverrides, isSkillEnabled, invocationPreference } from "../domain/model.ts";
import type { Manifest, State } from "../domain/model.ts";
import { claudeRelTarget } from "../domain/reconcile-plan.ts";
import { findUnindexedSkills } from "../lib/adopt.ts";
import { applyProfile, deleteProfile, editProfile, promoteProfile, renameProfileAction, setAutoinvoke, setProfileMembers, setSkillsEnabled } from "../lib/catalog-actions.ts";
import { verifyCatalog } from "../lib/convergence.ts";
import { inspectInstallation, invocationInfo } from "../lib/invocation.ts";
import { HostRepo, Paths } from "../lib/paths.ts";
import { observe } from "../lib/reconcile.ts";
import { c, pad, renderAction, renderConvergenceEvent, stripAnsi } from "./render.ts";
import { dryRunFlag, forceFlag, loadHostState, optionalSkillsArg, skillsArg, withRepo } from "./shared.ts";

const cmdStatus = Effect.fn("Cli.status")(function* (manifest: Manifest, state: State) {
  const paths = yield* Paths;
  const { repo } = yield* HostRepo;
  const obs = yield* observe();
  const nameW = Math.max(4, ...Object.keys(manifest.skills).map((n) => n.length)) + 2;
  console.log(c.dim(`host: ${repo}\nselection: ${describeSelection(manifest, state)}\n`));
  console.log(c.bold(`${pad("NAME", nameW)}${pad("ORIGIN", 8)}${pad("ENABLED", 9)}${pad("LIVE", 10)}${pad("CLAUDE", 8)}OPENCODE INVOCATION`));
  for (const [name, meta] of Object.entries(manifest.skills)) {
    const enabled = isSkillEnabled(manifest, state, name);
    const live: LiveEntry = Object.hasOwn(obs.agents, name) ? obs.agents[name]! : { kind: "missing" };
    const claudeEntry: LiveEntry = Object.hasOwn(obs.claude, name) ? obs.claude[name]! : { kind: "missing" };
    const claude = classifyPlacement(claudeEntry, resolve(paths.claudeSkills, claudeRelTarget(name))) === "expected-symlink" ? "yes" : c.dim("-");
    const source = resolve(repo, meta.path);
    const preference = invocationPreference(state, name);
    const file = join(source, "SKILL.md");
    const invocation = invocationInfo(existsSync(file) ? readFileSync(file, "utf8") : "", preference);
    const inspection = inspectInstallation({
      origin: meta.origin,
      enabled,
      live,
      source,
      baselineHash: meta.contentHash,
      path: join(paths.agentsSkills, name),
      preference,
      verify: true,
    });
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
      `${pad(name, nameW)}${pad(meta.origin, 8)}${pad(enabled ? "on" : c.dim("off"), enabled ? 9 : 9 + 9)}${pad(liveLabel, 10 + liveLabel.length - stripAnsi(liveLabel).length)}${pad(claude, 8 + claude.length - stripAnsi(claude).length)}${invocation.automatic ? "auto" : "manual"} (${invocation.source})`,
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

export const autoinvokeCommand = Command.make(
  "autoinvoke",
  {
    name: Argument.string("skill"),
    mode: Argument.choice("mode", ["on", "off", "inherit"] as const),
    dryRun: dryRunFlag,
  },
  ({ name, mode, dryRun }) =>
    withRepo(
      Effect.gen(function* () {
        renderAction(yield* setAutoinvoke(name, mode, { dryRun }));
      }),
    ),
).pipe(Command.withDescription("Set host-local OpenCode automatic discovery: on, off (manual), or inherit"));

/** One line describing what this machine follows, e.g. `profile fleet (+fizzy -tdd on this machine)`. */
export function describeSelection(manifest: Manifest, state: State): string {
  const profile = getActiveProfile(manifest, state);
  if (profile === null) return "custom selection (not following a profile)";
  const { enabled, disabled } = getProfileOverrides(state);
  const local = [...enabled.map((name) => `+${name}`), ...disabled.map((name) => `-${name}`)];
  return `profile ${profile}${local.length > 0 ? ` (${local.join(" ")} on this machine)` : ""}`;
}

const profileList = withRepo(
  Effect.gen(function* () {
    const { manifest, state } = yield* loadHostState;
    const entries = Object.entries(manifest.profiles);
    if (entries.length === 0) console.log(c.dim("no profiles defined; create one with `slinky profile add <name> <skill...>`"));
    for (const [name, skills] of entries) {
      const active = getActiveProfile(manifest, state) === name ? c.green(" (active)") : "";
      console.log(`${c.bold(name)}${active}: ${skills.join(", ")}`);
    }
    console.log(c.dim(`\nthis machine: ${describeSelection(manifest, state)}`));
  }),
);

const profileListCommand = Command.make("list", {}, () => profileList).pipe(Command.withDescription("List profiles"));

const makeProfileEditCommand = (verb: "add" | "remove", description: string) =>
  Command.make(verb, { name: Argument.string("profile"), skills: skillsArg, dryRun: dryRunFlag, force: forceFlag }, ({ name, skills, dryRun, force }) =>
    withRepo(
      Effect.gen(function* () {
        renderAction(yield* editProfile(name, verb === "add" ? skills : [], verb === "remove" ? skills : [], { dryRun, force }));
      }),
    ),
  ).pipe(Command.withDescription(description));

const profileAddCommand = makeProfileEditCommand("add", "Add skill(s) to a shared profile (creating it if needed); save and sync to share it");
const profileRemoveCommand = makeProfileEditCommand("remove", "Remove skill(s) from a shared profile; save and sync to share it");

const profileCreateCommand = Command.make("create", { name: Argument.string("profile"), skills: optionalSkillsArg, dryRun: dryRunFlag }, ({ name, skills, dryRun }) =>
  withRepo(
    Effect.gen(function* () {
      const { manifest, state } = yield* loadHostState;
      const members = skills.length > 0 ? skills : Object.keys(manifest.skills).filter((skill) => isSkillEnabled(manifest, state, skill));
      renderAction(yield* setProfileMembers(name, members, "create", { dryRun }));
    }),
  ),
).pipe(Command.withDescription("Create a shared profile from the named skills, or from what is enabled on this machine"));

const profileRenameCommand = Command.make("rename", { from: Argument.string("profile"), to: Argument.string("new-name"), dryRun: dryRunFlag }, ({ from, to, dryRun }) =>
  withRepo(
    Effect.gen(function* () {
      renderAction(yield* renameProfileAction(from, to, { dryRun }));
    }),
  ),
).pipe(Command.withDescription("Rename a shared profile; machines following it follow the new name after they sync"));

const profileDeleteCommand = Command.make("delete", { name: Argument.string("profile"), dryRun: dryRunFlag }, ({ name, dryRun }) =>
  withRepo(
    Effect.gen(function* () {
      renderAction(yield* deleteProfile(name, { dryRun }));
    }),
  ),
).pipe(Command.withDescription("Delete a shared profile (not the one this machine follows)"));

const profilePromoteCommand = Command.make("promote", { dryRun: dryRunFlag, force: forceFlag }, ({ dryRun, force }) =>
  withRepo(
    Effect.gen(function* () {
      renderAction(yield* promoteProfile({ dryRun, force }));
    }),
  ),
).pipe(Command.withDescription("Move this machine's own enable/disable changes into the profile it follows"));

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
).pipe(Command.withDescription("Follow a profile: enable exactly its skills and clear this machine's own changes"));

export const profileCommand = Command.make("profile", {}, () => profileList).pipe(
  Command.withDescription("List, follow, or edit shared profiles"),
  Command.withSubcommands([
    profileListCommand,
    profileApplyCommand,
    profileCreateCommand,
    profileAddCommand,
    profileRemoveCommand,
    profileRenameCommand,
    profileDeleteCommand,
    profilePromoteCommand,
  ]),
);

export const verifyCommand = Command.make("verify", {}, () =>
  withRepo(
    Effect.gen(function* () {
      yield* cmdVerify();
    }),
  ),
).pipe(Command.withDescription("Hash-check every skill against the manifest"));
