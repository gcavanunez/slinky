import { isAbsolute, normalize, posix } from "node:path";
import { DateTime, Schema } from "effect";

export const version = 1;
export const stateVersion = 2;

const SkillName = Schema.NonEmptyString;
const ProfileName = Schema.NonEmptyString;
const ContentHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const UpstreamTreeHash = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/));
export const PortableRelativePath = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) => {
      if (value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) return false;
      if (value === "." || posix.normalize(value) !== value) return false;
      return !value.split("/").includes("..");
    },
    { expected: "a normalized portable relative path" },
  ),
);
const LocalSkillPath = PortableRelativePath.check(Schema.isPattern(/^skills\/.+$/));
const VendorSkillPath = PortableRelativePath.check(Schema.isPattern(/^vendor\/[^/]+\/[^/]+$/));
const ProjectPath = Schema.NonEmptyString.check(Schema.makeFilter((value) => isAbsolute(value) && normalize(value) === value, { expected: "a normalized absolute project path" }));
const HostPath = Schema.NonEmptyString.check(Schema.makeFilter((value) => isAbsolute(value) && normalize(value) === value, { expected: "a normalized absolute skills host path" }));
export const RepositorySlug = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) => {
      const [owner, repository, extra] = value.split("/");
      if (!owner || !repository || extra !== undefined || repository === "." || repository === "..") {
        return false;
      }
      return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) && /^[A-Za-z0-9._-]+$/.test(repository);
    },
    { expected: "a GitHub repository in owner/name form" },
  ),
);
export const HttpUrl = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { expected: "an HTTP or HTTPS URL" },
  ),
);
const CanonicalUtc = Schema.DateTimeUtcFromString;

export const nowUtc = DateTime.nowUnsafe;
export const formatUtc = DateTime.formatIso;

const GitHubTracking = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tree"),
    path: PortableRelativePath,
    hash: UpstreamTreeHash,
  }),
  Schema.Struct({ kind: Schema.Literal("untracked") }),
]);

const VendorUpstream = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("github"),
    repository: RepositorySlug,
    url: Schema.NullOr(HttpUrl),
    tracking: GitHubTracking,
  }),
  Schema.Struct({
    kind: Schema.Literal("well-known"),
    source: Schema.NonEmptyString,
    url: Schema.NullOr(HttpUrl),
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
    note: Schema.NullOr(Schema.NonEmptyString),
  }),
]);

const LocalSkill = Schema.Struct({
  origin: Schema.Literal("local"),
  path: LocalSkillPath,
  contentHash: ContentHash,
});

const VendorSkill = Schema.Struct({
  origin: Schema.Literal("vendor"),
  path: VendorSkillPath,
  contentHash: ContentHash,
  upstream: VendorUpstream,
  vendoredAt: Schema.NullOr(CanonicalUtc),
});

export const Skill = Schema.Union([LocalSkill, VendorSkill]);
export type Skill = typeof Skill.Type;

export const Manifest = Schema.Struct({
  version: Schema.Literal(version),
  skills: Schema.Record(SkillName, Skill),
  profiles: Schema.Record(ProfileName, Schema.Array(SkillName)),
}).check(
  Schema.makeFilter((manifest) => {
    const issues: Array<Schema.FilterIssue> = [];
    const skillNames = new Set(Object.keys(manifest.skills));

    for (const [name, skill] of Object.entries(manifest.skills)) {
      if (posix.basename(skill.path) !== name) {
        issues.push({ path: ["skills", name, "path"], issue: "path must end with the skill name" });
      }
    }

    for (const [name, members] of Object.entries(manifest.profiles)) {
      if (new Set(members).size !== members.length) {
        issues.push({ path: ["profiles", name], issue: "profile members must be unique" });
      }
      for (const member of members) {
        if (!skillNames.has(member)) {
          issues.push({ path: ["profiles", name], issue: `unknown skill: ${member}` });
        }
      }
    }

    return issues;
  }),
);
export type Manifest = typeof Manifest.Type;

const LinkFields = {
  project: ProjectPath,
  skill: SkillName,
  targets: Schema.NonEmptyArray(PortableRelativePath),
  excludedTargets: Schema.Array(PortableRelativePath),
  linkedAt: CanonicalUtc,
};

const linkChecks = Schema.makeFilter<{
  readonly skill: string;
  readonly targets: ReadonlyArray<string>;
  readonly excludedTargets: ReadonlyArray<string>;
}>((link) => {
  const issues: Array<Schema.FilterIssue> = [];
  const canonical = `.agents/skills/${link.skill}`;
  const claude = `.claude/skills/${link.skill}`;
  if (link.targets[0] !== canonical) issues.push(`first link target must be ${canonical}`);
  if (link.targets.length > 2 || (link.targets.length === 2 && link.targets[1] !== claude)) {
    issues.push(`link targets may only include ${canonical} and ${claude}`);
  }
  if (new Set(link.targets).size !== link.targets.length) issues.push("link targets must be unique");
  if (new Set(link.excludedTargets).size !== link.excludedTargets.length) {
    issues.push("excluded targets must be unique");
  }
  for (const target of link.excludedTargets) {
    if (!link.targets.includes(target)) issues.push(`excluded target is not managed by the link: ${target}`);
  }
  return issues;
});

const CopyProjectLink = Schema.Struct({
  mode: Schema.Literal("copy"),
  ...LinkFields,
  snapshotHash: ContentHash,
}).check(linkChecks);

const SymlinkProjectLink = Schema.Struct({
  mode: Schema.Literal("symlink"),
  ...LinkFields,
}).check(linkChecks);

export const ProjectLink = Schema.Union([CopyProjectLink, SymlinkProjectLink]);
export type ProjectLink = typeof ProjectLink.Type;

export const StateSelection = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("custom"),
    disabledSkills: Schema.Array(SkillName),
  }),
  Schema.Struct({
    kind: Schema.Literal("profile"),
    name: ProfileName,
  }),
]);
export type StateSelection = typeof StateSelection.Type;

export const StateV1 = Schema.Struct({
  version: Schema.Literal(version),
  disabledSkills: Schema.Array(SkillName),
  activeProfile: Schema.NullOr(ProfileName),
  projectLinks: Schema.Array(ProjectLink),
  recentProjects: Schema.Array(ProjectPath),
}).check(
  Schema.makeFilter((state) => {
    const issues: Array<Schema.FilterIssue> = [];
    if (new Set(state.disabledSkills).size !== state.disabledSkills.length) {
      issues.push({ path: ["disabledSkills"], issue: "disabled skills must be unique" });
    }
    if (new Set(state.recentProjects).size !== state.recentProjects.length) {
      issues.push({ path: ["recentProjects"], issue: "recent projects must be unique" });
    }
    if (state.recentProjects.length > 10) {
      issues.push({ path: ["recentProjects"], issue: "at most 10 recent projects are retained" });
    }
    const links = new Set<string>();
    for (const link of state.projectLinks) {
      const key = `${link.project}\0${link.skill}`;
      if (links.has(key)) {
        issues.push({ path: ["projectLinks"], issue: `duplicate project link: ${link.skill}` });
      }
      links.add(key);
    }
    return issues;
  }),
);
export type StateV1 = typeof StateV1.Type;

export const State = Schema.Struct({
  version: Schema.Literal(stateVersion),
  selection: StateSelection,
  projectLinks: Schema.Array(ProjectLink),
  recentProjects: Schema.Array(ProjectPath),
}).check(
  Schema.makeFilter((state) => {
    const issues: Array<Schema.FilterIssue> = [];
    if (state.selection.kind === "custom" && new Set(state.selection.disabledSkills).size !== state.selection.disabledSkills.length) {
      issues.push({ path: ["selection", "disabledSkills"], issue: "disabled skills must be unique" });
    }
    if (new Set(state.recentProjects).size !== state.recentProjects.length) {
      issues.push({ path: ["recentProjects"], issue: "recent projects must be unique" });
    }
    if (state.recentProjects.length > 10) {
      issues.push({ path: ["recentProjects"], issue: "at most 10 recent projects are retained" });
    }
    const links = new Set<string>();
    for (const link of state.projectLinks) {
      const key = `${link.project}\0${link.skill}`;
      if (links.has(key)) {
        issues.push({ path: ["projectLinks"], issue: `duplicate project link: ${link.skill}` });
      }
      links.add(key);
    }
    return issues;
  }),
);
export type State = typeof State.Type;
export const PersistedState = Schema.Union([StateV1, State]);

/** Interactive diff pagers Slinky knows how to drive. */
export const DiffPager = Schema.Literals(["hunk", "delta"]);
export type DiffPager = typeof DiffPager.Type;

/** TUI colour themes. Palettes live in src/tui/theme.ts, keyed by these ids. */
export const themeIds = [
  "slinky",
  "tokyo-night",
  "tokyo-night-storm",
  "catppuccin",
  "catppuccin-latte",
  "rose-pine",
  "rose-pine-dawn",
  "gruvbox",
  "gruvbox-light",
  "nord",
  "dracula",
  "kanagawa",
  "one-dark",
  "one-light",
  "monokai",
  "solarized-dark",
  "solarized-light",
  "everforest",
  "vesper",
  "vague",
  "ayu",
  "ayu-mirage",
  "ayu-light",
  "github-dark-dimmed",
  "palenight",
  "opencode",
  "cursor",
] as const;
export const ThemeId = Schema.Literals(themeIds);
export type ThemeId = typeof ThemeId.Type;
export const defaultThemeId: ThemeId = "slinky";

export const SlinkyConfig = Schema.Struct({
  version: Schema.Literal(version),
  host: HostPath,
  /** Absent means "no pager": diffs print inline. */
  diffPager: Schema.optional(DiffPager),
  /** Editor command spec, flags included. Absent falls back to $VISUAL, $EDITOR, then nvim. */
  editor: Schema.optional(Schema.NonEmptyString.check(Schema.makeFilter((value) => value.trim() !== "", { expected: "a non-blank editor command" }))),
  /** TUI theme. Absent means the default slinky palette. */
  theme: Schema.optional(ThemeId),
});
export type SlinkyConfig = typeof SlinkyConfig.Type;

const decodeManifest = Schema.decodeUnknownSync(Schema.toType(Manifest));
const decodeState = Schema.decodeUnknownSync(Schema.toType(State));

export function getSkill(manifest: Manifest, name: string): Skill | undefined {
  return Object.hasOwn(manifest.skills, name) ? manifest.skills[name] : undefined;
}

export function getProfile(manifest: Manifest, name: string): ReadonlyArray<string> | undefined {
  return Object.hasOwn(manifest.profiles, name) ? manifest.profiles[name] : undefined;
}

export function withManifestSkill(manifest: Manifest, name: string, skill: Skill): Manifest {
  return decodeManifest({ ...manifest, skills: { ...manifest.skills, [name]: skill } });
}

export function emptyState(): State {
  return decodeState({
    version: stateVersion,
    selection: { kind: "custom", disabledSkills: [] },
    projectLinks: [],
    recentProjects: [],
  });
}

export function getActiveProfile(manifest: Manifest, state: State): string | null {
  return state.selection.kind === "profile" && Object.hasOwn(manifest.profiles, state.selection.name) ? state.selection.name : null;
}

export function getDisabledSkills(manifest: Manifest, state: State): ReadonlyArray<string> {
  if (state.selection.kind === "custom") return state.selection.disabledSkills;
  const members = getProfile(manifest, state.selection.name);
  if (!members) return [];
  const enabled = new Set(members);
  return Object.keys(manifest.skills)
    .filter((name) => !enabled.has(name))
    .sort();
}

export function isSkillEnabled(manifest: Manifest, state: State, name: string): boolean {
  return !getDisabledSkills(manifest, state).includes(name);
}

export function withSkillEnabled(manifest: Manifest, state: State, name: string, enabled: boolean): State {
  const disabled = new Set(getDisabledSkills(manifest, state));
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  return decodeState({
    ...state,
    selection: { kind: "custom", disabledSkills: [...disabled].sort() },
  });
}

export function withProfile(manifest: Manifest, state: State, name: string): State {
  const members = getProfile(manifest, name);
  if (!members) throw new Error(`unknown profile: ${name}`);
  return decodeState({
    ...state,
    selection: { kind: "profile", name },
  });
}

export function alignStateWithManifest(manifest: Manifest, state: State): State {
  if (state.selection.kind === "profile") {
    if (Object.hasOwn(manifest.profiles, state.selection.name)) return state;
    // A v2 profile has no cached custom complement. If it is retired, fall back
    // to the default all-enabled catalog rather than inventing stale choices.
    return decodeState({ ...state, selection: { kind: "custom", disabledSkills: [] } });
  }
  return decodeState({
    ...state,
    selection: {
      kind: "custom",
      disabledSkills: state.selection.disabledSkills.filter((name) => Object.hasOwn(manifest.skills, name)),
    },
  });
}

export function alignStateForTransition(previous: Manifest, resulting: Manifest, state: State): State {
  if (state.selection.kind !== "profile" || Object.hasOwn(resulting.profiles, state.selection.name)) {
    return alignStateWithManifest(resulting, state);
  }
  const disabledSkills = getDisabledSkills(previous, state).filter((name) => Object.hasOwn(resulting.skills, name));
  return decodeState({ ...state, selection: { kind: "custom", disabledSkills } });
}

export function migrateStateV1(manifest: Manifest, state: StateV1): State {
  const selection: StateSelection =
    state.activeProfile !== null && Object.hasOwn(manifest.profiles, state.activeProfile)
      ? { kind: "profile", name: state.activeProfile }
      : {
          kind: "custom",
          disabledSkills: state.disabledSkills.filter((name) => Object.hasOwn(manifest.skills, name)),
        };
  return decodeState({
    version: stateVersion,
    selection,
    projectLinks: state.projectLinks,
    recentProjects: state.recentProjects,
  });
}

export function withProjectLink(state: State, link: ProjectLink): State {
  return decodeState({
    ...state,
    projectLinks: [...state.projectLinks, link],
    recentProjects: [link.project, ...state.recentProjects.filter((project) => project !== link.project)].slice(0, 10),
  });
}

export function withoutProjectLink(state: State, link: ProjectLink): State {
  return decodeState({
    ...state,
    projectLinks: state.projectLinks.filter((candidate) => candidate !== link),
  });
}

export function validateState(manifest: Manifest, state: State): ReadonlyArray<string> {
  const issues: string[] = [];
  if (state.selection.kind === "custom") {
    for (const name of state.selection.disabledSkills) {
      if (!Object.hasOwn(manifest.skills, name)) issues.push(`disabled skill is not in the manifest: ${name}`);
    }
  } else if (!Object.hasOwn(manifest.profiles, state.selection.name)) {
    issues.push(`active profile is not in the manifest: ${state.selection.name}`);
  }
  for (const link of state.projectLinks) {
    if (!Object.hasOwn(manifest.skills, link.skill)) {
      issues.push(`project link references unknown skill: ${link.skill}`);
    }
  }
  return issues;
}

const FileOperation = Schema.Literals(["read", "parse", "decode", "encode", "write", "rename"]);
export type FileOperation = typeof FileOperation.Type;

const FileErrorFields = {
  path: Schema.String,
  operation: FileOperation,
  detail: Schema.String,
  message: Schema.String,
};

const fileErrorArgs = (path: string, operation: FileOperation, detail: string) => ({
  path,
  operation,
  detail,
  message: `${operation} ${path}: ${detail}`,
});

/** Render any thrown value as a human-readable detail string. */
export const errorDetail = <Thrown>(error: Thrown): string => (error instanceof Error ? error.message : String(error));

const MissingFileError = Schema.instanceOf(Error).check(Schema.makeFilter((error) => "code" in error && error.code === "ENOENT"));

/** True when an fs error means "file does not exist". */
export const isMissingFile = Schema.is(MissingFileError);

/** Expected domain-rule failure (unknown skill, drift guard, existing destination, ...). */
export class OperationFailed extends Schema.TaggedErrorClass<OperationFailed>()("OperationFailed", {
  message: Schema.String,
}) {}

/** An external tool (git, tar, npx skills, ...) failed at an adapter boundary. */
export class ExternalToolError extends Schema.TaggedErrorClass<ExternalToolError>()("ExternalToolError", {
  tool: Schema.String,
  message: Schema.String,
}) {}

export class ManifestFileError extends Schema.TaggedErrorClass<ManifestFileError>()("ManifestFileError", FileErrorFields) {
  constructor(path: string, operation: FileOperation, detail: string) {
    super(fileErrorArgs(path, operation, detail));
  }
}

export class StateFileError extends Schema.TaggedErrorClass<StateFileError>()("StateFileError", FileErrorFields) {
  constructor(path: string, operation: FileOperation, detail: string) {
    super(fileErrorArgs(path, operation, detail));
  }
}

export class ConfigFileError extends Schema.TaggedErrorClass<ConfigFileError>()("ConfigFileError", FileErrorFields) {
  constructor(path: string, operation: FileOperation, detail: string) {
    super(fileErrorArgs(path, operation, detail));
  }
}

export class SkillLockDecodeError extends Schema.TaggedErrorClass<SkillLockDecodeError>()("SkillLockDecodeError", FileErrorFields) {
  constructor(path: string, operation: FileOperation, detail: string) {
    super(fileErrorArgs(path, operation, detail));
  }
}
