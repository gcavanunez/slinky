import { Effect } from "effect";
import { OperationFailed } from "../domain/model.ts";

/**
 * Run a synchronous operation whose expected failures are thrown
 * `OperationFailed` values. Anything else is an unexpected defect.
 */
export const tryOp = <A>(evaluate: () => A): Effect.Effect<A, OperationFailed> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(evaluate());
    } catch (error) {
      return error instanceof OperationFailed ? Effect.fail(error) : Effect.die(error);
    }
  });
