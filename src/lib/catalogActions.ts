import type { ProjectLink, State } from "../domain/model.ts";
import {
  getProfile,
  getSkill,
  loadManifest,
  loadState,
  saveState,
  withProfile,
  withSkillEnabled,
} from "./manifest.ts";
import { applyUnlink, linkSkill, prepareUnlink, unlinkSkill } from "./linker.ts";
import type { LinkOptions } from "./linker.ts";
import { apply, observe, planSync } from "./reconcile.ts";

export interface ActionResult {
  readonly messages: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly dryRun: boolean;
}

export interface MutationOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

function changeState(
  manifest: ReturnType<typeof loadManifest>,
  next: State,
  options: MutationOptions,
): ActionResult {
  const plan = planSync(manifest, next, observe(), { force: options.force });
  if (options.dryRun) {
    return {
      messages: plan.actions.map((action) => `${action.type} ${action.skill}`),
      warnings: plan.warnings,
      dryRun: true,
    };
  }

  saveState(next);
  const result = apply(plan, { force: options.force });
  return {
    messages: result.done,
    warnings: [...plan.warnings, ...result.skipped],
    dryRun: false,
  };
}

export function setSkillsEnabled(
  names: ReadonlyArray<string>,
  enabled: boolean,
  options: MutationOptions = {},
): ActionResult {
  const manifest = loadManifest();
  const state = loadState(manifest);
  for (const name of names) {
    if (!getSkill(manifest, name)) throw new Error(`unknown skill: ${name}`);
  }
  const next = names.reduce(
    (current, name) => withSkillEnabled(current, name, enabled),
    state,
  );
  return changeState(manifest, next, options);
}

export function applyProfile(name: string, options: MutationOptions = {}): ActionResult {
  const manifest = loadManifest();
  const state = loadState(manifest);
  if (!getProfile(manifest, name)) throw new Error(`unknown profile: ${name}`);
  return changeState(manifest, withProfile(manifest, state, name), options);
}

export function linkProjectSkill(options: LinkOptions): { readonly link: ProjectLink } {
  const manifest = loadManifest();
  const state = loadState(manifest);
  const result = linkSkill(manifest, state, options);
  try {
    saveState(result.state);
  } catch (error) {
    try {
      unlinkSkill(manifest, result.state, result.link.skill, result.link.project, { force: true });
    } catch {}
    throw error;
  }
  return { link: result.link };
}

export function unlinkProjectSkill(
  skill: string,
  project: string,
  options: { readonly force?: boolean } = {},
): { readonly link: ProjectLink; readonly warnings: ReadonlyArray<string> } {
  const manifest = loadManifest();
  const state = loadState(manifest);
  const result = prepareUnlink(manifest, state, skill, project, options);
  saveState(result.state);
  try {
    return { link: result.link, warnings: applyUnlink(result.link) };
  } catch (error) {
    try {
      saveState(state);
    } catch {}
    throw error;
  }
}
