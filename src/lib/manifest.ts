import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  alignStateForTransition,
  emptyState,
  errorDetail,
  isMissingFile,
  Manifest,
  ManifestFileError,
  migrateStateV1,
  PersistedState,
  State,
  StateFileError,
  stateVersion,
  validateState,
} from "../domain/model.ts";
import type { FileOperation } from "../domain/model.ts";
import { HostRepo } from "./paths.ts";

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

const writeOwnedFile = <E>(path: string, contents: string, ErrorClass: FileErrorClass<E>) =>
  Effect.gen(function* () {
    const tmp = `${path}.${process.pid}.tmp`;
    yield* Effect.try({
      try: () => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, contents);
      },
      catch: (error) => new ErrorClass(tmp, "write", errorDetail(error)),
    });
    yield* Effect.try({
      try: () => renameSync(tmp, path),
      catch: (error) => new ErrorClass(path, "rename", errorDetail(error)),
    });
  });

const writeOwnedJson = <E>(path: string, value: Schema.Json, ErrorClass: FileErrorClass<E>) => writeOwnedFile(path, `${JSON.stringify(value, null, 2)}\n`, ErrorClass);

export interface PersistenceSnapshot {
  readonly contents: string | null;
}

export interface ManifestStoreInterface {
  readonly loadManifest: () => Effect.Effect<Manifest, ManifestFileError>;
  readonly saveManifest: (manifest: Manifest) => Effect.Effect<void, ManifestFileError>;
  readonly snapshotManifestFile: () => Effect.Effect<PersistenceSnapshot, ManifestFileError>;
  readonly restoreManifestFile: (snapshot: PersistenceSnapshot) => Effect.Effect<void, ManifestFileError>;
  readonly loadState: (manifest: Manifest) => Effect.Effect<State, StateFileError>;
  readonly loadStateForTransition: (manifest: Manifest, projectLinkManifest: Manifest) => Effect.Effect<State, StateFileError>;
  readonly snapshotStateFile: () => Effect.Effect<PersistenceSnapshot, StateFileError>;
  readonly restoreStateFile: (snapshot: PersistenceSnapshot) => Effect.Effect<void, StateFileError>;
  readonly saveState: (state: State) => Effect.Effect<void, StateFileError>;
}

export class ManifestStore extends Context.Service<ManifestStore, ManifestStoreInterface>()("slinky/ManifestStore") {
  static readonly layer: Layer.Layer<ManifestStore, never, HostRepo> = Layer.effect(
    ManifestStore,
    Effect.gen(function* () {
      const { manifestPath, statePath } = yield* HostRepo;

      const loadState = Effect.fn("ManifestStore.loadState")(function* (manifest: Manifest, projectLinkManifest: Manifest) {
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
        const decoded = yield* Schema.decodeUnknownEffect(PersistedState)(input, strict).pipe(
          Effect.mapError((error) => new StateFileError(statePath, "decode", errorDetail(error))),
        );
        const state = decoded.version === stateVersion ? alignStateForTransition(projectLinkManifest, manifest, decoded) : migrateStateV1(manifest, decoded);
        const issues = [
          ...validateState(manifest, { ...state, projectLinks: [] }),
          ...state.projectLinks.filter((link) => !Object.hasOwn(projectLinkManifest.skills, link.skill)).map((link) => `project link references unknown skill: ${link.skill}`),
        ];
        if (issues.length > 0) return yield* Effect.fail(new StateFileError(statePath, "decode", issues.join("; ")));
        return state;
      });

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

        snapshotManifestFile: Effect.fn("ManifestStore.snapshotManifestFile")(function* () {
          return { contents: yield* readOwnedFile(manifestPath, ManifestFileError) } satisfies PersistenceSnapshot;
        }),

        restoreManifestFile: Effect.fn("ManifestStore.restoreManifestFile")(function* (snapshot: PersistenceSnapshot) {
          if (snapshot.contents === null) return yield* Effect.fail(new ManifestFileError(manifestPath, "write", "manifest snapshot is missing"));
          yield* writeOwnedFile(manifestPath, snapshot.contents, ManifestFileError);
        }),

        loadState: (manifest) => loadState(manifest, manifest),

        loadStateForTransition: loadState,

        snapshotStateFile: Effect.fn("ManifestStore.snapshotStateFile")(function* () {
          return yield* Effect.try({
            try: () => readFileSync(statePath, "utf8"),
            catch: (error) => error,
          }).pipe(
            Effect.map((contents) => ({ contents }) satisfies PersistenceSnapshot),
            Effect.catch((error) =>
              isMissingFile(error) ? Effect.succeed({ contents: null } satisfies PersistenceSnapshot) : Effect.fail(new StateFileError(statePath, "read", errorDetail(error))),
            ),
          );
        }),

        restoreStateFile: Effect.fn("ManifestStore.restoreStateFile")(function* (snapshot: PersistenceSnapshot) {
          if (snapshot.contents !== null) return yield* writeOwnedFile(statePath, snapshot.contents, StateFileError);
          yield* Effect.try({
            try: () => rmSync(statePath, { force: true }),
            catch: (error) => new StateFileError(statePath, "write", errorDetail(error)),
          });
        }),

        saveState: Effect.fn("ManifestStore.saveState")(function* (state: State) {
          const encoded = yield* Schema.encodeEffect(State)(state, strict).pipe(Effect.mapError((error) => new StateFileError(statePath, "encode", errorDetail(error))));
          const selection = encoded.selection.kind === "custom" ? { kind: "custom" as const, disabledSkills: [...encoded.selection.disabledSkills].sort() } : encoded.selection;
          yield* writeOwnedJson(statePath, { ...encoded, selection }, StateFileError);
        }),
      });
    }),
  );
}
