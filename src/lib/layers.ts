import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type { ConfigFileError } from "../domain/model.ts";
import { ManifestStore } from "./manifest.ts";
import { HostRepo, Paths } from "./paths.ts";
import type { RepoNotFoundError } from "./paths.ts";
import { GitHub } from "./update.ts";

/**
 * Repo-scoped services. Building this layer performs repo discovery, so it
 * fails typed (`RepoNotFoundError | ConfigFileError`) when no host repo is
 * configured — repo-less commands (`init`, `bootstrap --clone`) must not
 * depend on it. The HTTP client is an implementation detail of `GitHub` and
 * stays hidden.
 */
export const layerRepo: Layer.Layer<ManifestStore | GitHub | HostRepo, RepoNotFoundError | ConfigFileError, Paths> = Layer.mergeAll(ManifestStore.layer, GitHub.layer).pipe(
  Layer.provideMerge(HostRepo.layer),
  Layer.provide(FetchHttpClient.layer),
);

/** Full application graph (TUI runtime): repo services plus `Paths`. */
export const layerApp: Layer.Layer<ManifestStore | GitHub | HostRepo | Paths, RepoNotFoundError | ConfigFileError> = layerRepo.pipe(Layer.provideMerge(Paths.layer));
