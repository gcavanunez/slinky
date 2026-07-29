import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as Schema from "effect/Schema";
import { emptyState, Manifest, ManifestFileError, State, StateFileError, validateState } from "../domain/model.ts";
import { MANIFEST_PATH, STATE_PATH } from "./paths.ts";

export {
  Manifest,
  ProjectLink,
  Skill,
  State,
  alignStateWithManifest,
  formatUtc,
  getProfile,
  getSkill,
  isSkillEnabled,
  nowUtc,
  version,
  withManifestSkill,
  withProfile,
  withProjectLink,
  withSkillEnabled,
  withoutProjectLink,
} from "../domain/model.ts";

const strict = { errors: "all", onExcessProperty: "error" } as const;
const missing = Symbol("missing-owned-file");

const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

function readOwnedJson(path: string, ErrorClass: typeof ManifestFileError | typeof StateFileError, missingIsEmpty = false): unknown | typeof missing {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (missingIsEmpty && isMissing(error)) return missing;
    throw new ErrorClass(path, "read", detail(error));
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ErrorClass(path, "parse", detail(error));
  }
}

function writeOwnedJson(path: string, value: unknown, ErrorClass: typeof ManifestFileError | typeof StateFileError): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    throw new ErrorClass(tmp, "write", detail(error));
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    throw new ErrorClass(path, "rename", detail(error));
  }
}

export function loadManifest(): Manifest {
  const input = readOwnedJson(MANIFEST_PATH, ManifestFileError);
  try {
    return Schema.decodeUnknownSync(Manifest)(input, strict);
  } catch (error) {
    throw new ManifestFileError(MANIFEST_PATH, "decode", detail(error));
  }
}

export function saveManifest(manifest: Manifest): void {
  let encoded: typeof Manifest.Encoded;
  try {
    encoded = Schema.encodeSync(Manifest)(manifest, strict);
  } catch (error) {
    throw new ManifestFileError(MANIFEST_PATH, "encode", detail(error));
  }
  const sorted = {
    ...encoded,
    skills: Object.fromEntries(Object.entries(encoded.skills).sort(([a], [b]) => a.localeCompare(b))),
    profiles: Object.fromEntries(Object.entries(encoded.profiles).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeOwnedJson(MANIFEST_PATH, sorted, ManifestFileError);
}

export function loadState(manifest: Manifest): State {
  const input = readOwnedJson(STATE_PATH, StateFileError, true);
  if (input === missing) return emptyState();

  let state: State;
  try {
    state = Schema.decodeUnknownSync(State)(input, strict);
  } catch (error) {
    throw new StateFileError(STATE_PATH, "decode", detail(error));
  }

  const issues = validateState(manifest, state);
  if (issues.length > 0) throw new StateFileError(STATE_PATH, "decode", issues.join("; "));
  return state;
}

export function saveState(state: State): void {
  let encoded: typeof State.Encoded;
  try {
    encoded = Schema.encodeSync(State)(state, strict);
  } catch (error) {
    throw new StateFileError(STATE_PATH, "encode", detail(error));
  }
  writeOwnedJson(STATE_PATH, { ...encoded, disabledSkills: [...encoded.disabledSkills].sort() }, StateFileError);
}
