import { Cause, Exit, ManagedRuntime } from "effect";
import type { Effect, Layer } from "effect";
import { layerApp } from "../lib/layers.ts";

export type AppEnv = Layer.Success<typeof layerApp>;

/** One shared runtime for the whole TUI session. */
export const runtime = ManagedRuntime.make(layerApp);

/** Run a synchronous app effect; typed failures and defects throw. */
export const runSync = <A, E>(effect: Effect.Effect<A, E, AppEnv>): A => runtime.runSync(effect);

export type RunResult<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string };

const fromExit = <A, E>(exit: Exit.Exit<A, E>): RunResult<A> => {
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
  const error = Cause.squash(exit.cause);
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
};

/** Run a synchronous app effect, reporting any failure as a message. */
export const runSyncResult = <A, E>(effect: Effect.Effect<A, E, AppEnv>): RunResult<A> => fromExit(runtime.runSyncExit(effect));

/** Run an async app effect, reporting any failure as a message. */
export const runPromiseResult = async <A, E>(effect: Effect.Effect<A, E, AppEnv>): Promise<RunResult<A>> => fromExit(await runtime.runPromiseExit(effect));
