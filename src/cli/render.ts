import { Match } from "effect";
import type { AdoptionResult } from "../lib/adopt.ts";
import type { ActionResult } from "../lib/catalog-actions.ts";
import type { ConvergenceEvent } from "../lib/convergence.ts";

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export function renderConvergenceEvent(event: ConvergenceEvent): void {
  if (event.type === "section") {
    if (event.leadingBlank) console.log("");
    console.log(c.bold(event.title));
    return;
  }
  if (event.type === "git-output") {
    const output = `${event.stdout}${event.stderr}`.trim();
    if (output) console.log(output);
    return;
  }
  const rendered = Match.value(event.tone).pipe(
    Match.when("dim", () => c.dim(event.message)),
    Match.when("error", () => c.red(event.message)),
    Match.when("success", () => c.green(event.message)),
    Match.when("warning", () => c.yellow(event.message)),
    Match.when(Match.undefined, () => event.message),
    Match.exhaustive,
  );
  console.log(rendered);
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex -- ANSI escape sequences begin with this control character.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function renderAction(result: ActionResult): void {
  for (const warning of result.warnings) console.log(c.yellow(`warn: ${warning}`));
  if (result.dryRun) {
    if (result.messages.length === 0) console.log("nothing to do");
    for (const message of result.messages) console.log(`would ${message}`);
    return;
  }
  for (const message of result.messages) console.log(`  ${message}`);
  if (result.messages.length === 0 && result.warnings.length === 0) {
    console.log("in sync; nothing to do");
  }
}

export const renderAdoptions = (result: AdoptionResult): void => {
  for (const record of result.adopted) console.log(`adopted ${c.bold(record.name)} -> ${record.path}`);
  for (const warning of result.warnings) console.log(c.yellow(`warn: ${warning}`));
};
