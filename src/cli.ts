#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import packageJson from "../package.json" with { type: "json" };
import { adoptCommand, skillsCommand } from "./cli/adopt-commands.ts";
import { disableCommand, enableCommand, profileCommand, statusCommand, verifyCommand } from "./cli/catalog-commands.ts";
import { pullCommand, pushCommand, saveCommand, syncCommand } from "./cli/convergence-commands.ts";
import { linkCommand, linksCommand, unlinkCommand } from "./cli/link-commands.ts";
import { c } from "./cli/render.ts";
import { bootstrapCommand, configCommand, initCommand, tuiCommand, versionCommand } from "./cli/setup-commands.ts";
import { diffCommand, rehashCommand, restoreCommand, updateCommand, vendorCommand } from "./cli/vendor-commands.ts";
import { RepoNotFoundError, Paths } from "./lib/paths.ts";

const root = Command.make("slinky").pipe(
  Command.withDescription("Slinky skill manager (no command opens the TUI)"),
  Command.withSubcommands([
    tuiCommand,
    initCommand,
    bootstrapCommand,
    statusCommand,
    syncCommand,
    pullCommand,
    pushCommand,
    enableCommand,
    disableCommand,
    profileCommand,
    configCommand,
    linkCommand,
    unlinkCommand,
    linksCommand,
    diffCommand,
    updateCommand,
    skillsCommand,
    vendorCommand,
    restoreCommand,
    rehashCommand,
    adoptCommand,
    saveCommand,
    verifyCommand,
    versionCommand,
  ]),
);

// --- runtime boundary -----------------------------------------------------

function renderFailure(cause: unknown): never {
  // Usage errors and help output are already rendered by the CLI framework.
  if (CliError.isCliError(cause)) process.exit(1);
  if (cause instanceof RepoNotFoundError) {
    const slinkyConfig = join(homedir(), ".config", "slinky", "config.json");
    console.error(
      c.red(
        `error: no skills repo found. slinky looks in $SLINKY_REPO, ${slinkyConfig}, and parent dirs.\n` +
          `  existing clone:  slinky init <path-to-clone>\n` +
          `  fresh machine:   slinky bootstrap --clone=<git-url> [--dest=<path>]`,
      ),
    );
    process.exit(1);
  }
  console.error(c.red(`error: ${cause instanceof Error ? cause.message : String(cause)}`));
  process.exit(1);
}

const argv = process.argv.slice(2);
const effectiveArgv = argv.length === 0 ? ["tui"] : argv[0] === "help" && argv.length === 1 ? ["--help"] : argv;

const exit = await Effect.runPromiseExit(
  Command.runWith(root, { version: packageJson.version })(effectiveArgv).pipe(Effect.provide(Layer.mergeAll(Paths.layer, BunServices.layer))),
);
if (Exit.isFailure(exit)) renderFailure(Cause.squash(exit.cause));
