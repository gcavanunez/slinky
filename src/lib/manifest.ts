import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { emptyState, errorDetail, isMissingFile, Manifest, ManifestFileError, State, StateFileError, validateState } from "../domain/model.ts";
import type { FileOperation } from "../domain/model.ts";
import { HostRepo } from "./paths.ts";

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
const decodeJson = Schema.decodeUnknownSync(Schema.Json);

type FileErrorClass<E> = new (path: string, operation: FileOperation, detail: string) => E;

const readOwnedFile = <E>(path: string, ErrorClass: FileErrorClass<E>) =>
  Effect.try({
    try: () => readFileSync(path, "utf8"),
    catch: (error) => new ErrorClass(path, "read", errorDetail(error)),
  });

const parseOwnedJson = <E>(path: string, raw: string, ErrorClass: FileErrorClass<E>) =>
  Effect.try({
    try: () => decodeJson(JSON.parse(raw)),
    catch: (error) => new ErrorClass(path, "parse", errorDetail(error)),
  });

const writeOwnedJson = <E>(path: string, value: Schema.Json, ErrorClass: FileErrorClass<E>) =>
  Effect.gen(function* () {
    const tmp = `${path}.${process.pid}.tmp`;
    yield* Effect.try({
      try: () => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
      },
      catch: (error) => new ErrorClass(tmp, "write", errorDetail(error)),
    });
    yield* Effect.try({
      try: () => renameSync(tmp, path),
      catch: (error) => new ErrorClass(path, "rename", errorDetail(error)),
    });
  });

export interface ManifestStoreInterface {
  readonly loadManifest: () => Effect.Effect<Manifest, ManifestFileError>;
  readonly saveManifest: (manifest: Manifest) => Effect.Effect<void, ManifestFileError>;
  readonly loadState: (manifest: Manifest) => Effect.Effect<State, StateFileError>;
  readonly saveState: (state: State) => Effect.Effect<void, StateFileError>;
}

export class ManifestStore extends Context.Service<ManifestStore, ManifestStoreInterface>()("slinky/ManifestStore") {
  static readonly layer: Layer.Layer<ManifestStore, never, HostRepo> = Layer.effect(
    ManifestStore,
    Effect.gen(function* () {
      const { manifestPath, statePath } = yield* HostRepo;

      return ManifestStore.of({
        loadManifest: Effect.fn("ManifestStore.loadManifest")(function* () {
          const raw = yield* readOwnedFile(manifestPath, ManifestFileError);
          const input = yield* parseOwnedJson(manifestPath, raw, ManifestFileError);
          return yield* Schema.decodeUnknownEffect(Manifest)(input, strict).pipe(Effect.mapError((error) => new ManifestFileError(manifestPath, "decode", errorDetail(error))));
        }),

        saveManifest: Effect.fn("ManifestStore.saveManifest")(function* (manifest: Manifest) {
          const encoded = yield* Schema.encodeEffect(Manifest)(manifest, strict).pipe(
            Effect.mapError((error) => new ManifestFileError(manifestPath, "encode", errorDetail(error))),
          );
          const sorted = {
            ...encoded,
            skills: Object.fromEntries(Object.entries(encoded.skills).sort(([a], [b]) => a.localeCompare(b))),
            profiles: Object.fromEntries(Object.entries(encoded.profiles).sort(([a], [b]) => a.localeCompare(b))),
          };
          yield* writeOwnedJson(manifestPath, sorted, ManifestFileError);
        }),

        loadState: Effect.fn("ManifestStore.loadState")(function* (manifest: Manifest) {
          // A missing state file scaffolds empty state; any other read error is real.
          const raw = yield* Effect.try({
            try: () => readFileSync(statePath, "utf8"),
            catch: (error) => error,
          }).pipe(
            Effect.map(Option.some),
            Effect.catch((error) => (isMissingFile(error) ? Effect.succeed(Option.none<string>()) : Effect.fail(new StateFileError(statePath, "read", errorDetail(error))))),
          );
          if (Option.isNone(raw)) return emptyState();

          const input = yield* parseOwnedJson(statePath, raw.value, StateFileError);
          const state = yield* Schema.decodeUnknownEffect(State)(input, strict).pipe(Effect.mapError((error) => new StateFileError(statePath, "decode", errorDetail(error))));

          const issues = validateState(manifest, state);
          if (issues.length > 0) return yield* Effect.fail(new StateFileError(statePath, "decode", issues.join("; ")));
          return state;
        }),

        saveState: Effect.fn("ManifestStore.saveState")(function* (state: State) {
          const encoded = yield* Schema.encodeEffect(State)(state, strict).pipe(Effect.mapError((error) => new StateFileError(statePath, "encode", errorDetail(error))));
          yield* writeOwnedJson(statePath, { ...encoded, disabledSkills: [...encoded.disabledSkills].sort() }, StateFileError);
        }),
      });
    }),
  );
}
