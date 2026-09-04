import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { linkProjectSkill, unlinkProjectSkill } from "../lib/catalog-actions.ts";
import { checkLink } from "../lib/linker.ts";
import { HostRepo } from "../lib/paths.ts";
import { c } from "./render.ts";
import { forceFlag, loadHostState, withRepo } from "./shared.ts";

export const linkCommand = Command.make(
  "link",
  {
    skill: Argument.string("skill"),
    project: Argument.string("project").pipe(Argument.optional),
    copy: Flag.boolean("copy").pipe(Flag.withDescription("Copy the skill into the project (default)")),
    symlink: Flag.boolean("symlink").pipe(Flag.withDescription("Symlink the skill into the project")),
    noExclude: Flag.boolean("no-exclude").pipe(Flag.withDescription("Do not add entries to .git/info/exclude")),
    noClaude: Flag.boolean("no-claude").pipe(Flag.withDescription("Do not create the .claude/skills symlink")),
  },
  (input) =>
    withRepo(
      Effect.gen(function* () {
        const project = Option.getOrElse(input.project, () => process.cwd());
        const mode = input.copy ? "copy" : input.symlink ? "symlink" : "copy";
        const result = yield* linkProjectSkill({
          skill: input.skill,
          project,
          mode,
          gitExclude: !input.noExclude,
          claude: !input.noClaude,
        });
        const link = result.link;
        console.log(`linked ${c.bold(input.skill)} (${mode}) into ${link.project}`);
        for (const t of link.targets) console.log(`  ${t}`);
        if (link.excludedTargets.length > 0) console.log(c.dim("  added to .git/info/exclude"));
      }),
    ),
).pipe(Command.withDescription("Link a skill into a project (project defaults to the current directory)"));

export const unlinkCommand = Command.make(
  "unlink",
  {
    skill: Argument.string("skill"),
    project: Argument.string("project").pipe(Argument.optional),
    force: forceFlag,
  },
  (input) =>
    withRepo(
      Effect.gen(function* () {
        const result = yield* unlinkProjectSkill(
          input.skill,
          Option.getOrElse(input.project, () => process.cwd()),
          {
            force: input.force,
          },
        );
        for (const warning of result.warnings) console.log(c.yellow(`warn: ${warning}`));
        console.log(`unlinked ${c.bold(input.skill)} from ${result.link.project}`);
      }),
    ),
).pipe(Command.withDescription("Remove a recorded project link"));

export const linksCommand = Command.make("links", { check: Flag.boolean("check").pipe(Flag.withDescription("Verify each link's health")) }, ({ check }) =>
  withRepo(
    Effect.gen(function* () {
      const { manifest, state } = yield* loadHostState;
      const { repo } = yield* HostRepo;
      if (state.projectLinks.length === 0) {
        console.log(c.dim("no project links recorded"));
        return;
      }
      for (const link of state.projectLinks) {
        const status = check ? ` [${checkLink(manifest, link, repo)}]` : "";
        console.log(`${c.bold(link.skill)} -> ${link.project} (${link.mode})${status}`);
      }
    }),
  ),
).pipe(Command.withDescription("List recorded project links"));
