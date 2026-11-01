import { Cause, Effect, Exit, Scope } from "effect";
import type { WorkspaceRuntime } from "./types.ts";

export type WorkspaceRuntimeParts = Omit<WorkspaceRuntime, "dispose">;

/**
 * Builds a workspace runtime as a scoped resource.
 *
 * `build` acquires the runtime's resources (operator host, permission tracker,
 * change monitor, document registry) in its own child scope, registering each
 * release as it goes. If building fails or is interrupted, everything acquired
 * so far is released before the failure propagates.
 *
 * The returned runtime is released when the surrounding scope closes, or
 * earlier through `runtime.dispose()`, the idempotent Promise facade used by the
 * document layer. Releases run in reverse acquisition order, all of them run
 * even when one fails, and a failed release rejects `dispose()` with that error
 * (or an `AggregateError` when several failed).
 */
export const makeScopedWorkspaceRuntime = <E, R>(
  build: Effect.Effect<WorkspaceRuntimeParts, E, R>,
): Effect.Effect<WorkspaceRuntime, E, Exclude<R, Scope.Scope> | Scope.Scope> =>
  Effect.gen(function* () {
    let parent = yield* Effect.scope;
    let own = yield* Scope.fork(parent, "sequential");
    let parts = yield* build.pipe(
      Scope.provide(own),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(own, exit) : Effect.void)),
    );
    let disposal: Promise<void> | null = null;
    return {
      ...parts,
      dispose: () => (disposal ??= closeRuntimeScope(own)),
    } satisfies WorkspaceRuntime;
  });

/**
 * Treats a runtime built outside Effect (tests, in-memory runtimes) as a scoped
 * resource whose release is its own `dispose()`, unless `shouldDispose` says
 * the scope no longer owns it.
 */
export const adoptWorkspaceRuntime = (
  runtime: WorkspaceRuntime,
  shouldDispose: () => boolean = () => true,
) =>
  Effect.acquireRelease(Effect.succeed(runtime), (adopted) =>
    shouldDispose()
      ? Effect.tryPromise({ catch: (cause) => cause, try: () => adopted.dispose() }).pipe(
          Effect.orDie,
        )
      : Effect.void,
  );

/** Adds a scoped release for a resource with a synchronous `dispose()`. */
export const acquireDisposable = <A extends { dispose(): void }>(acquire: () => A) =>
  Effect.acquireRelease(Effect.sync(acquire), (resource) => Effect.sync(() => resource.dispose()));

async function closeRuntimeScope(scope: Scope.Closeable) {
  let exit = await Effect.runPromiseExit(Scope.close(scope, Exit.void));
  if (Exit.isSuccess(exit)) return;
  throw releaseFailure(exit.cause);
}

/** Converts a failed scope close into the error `dispose()` rejects with. */
export function releaseFailure(cause: Cause.Cause<unknown>) {
  let errors = cause.reasons.flatMap((reason) =>
    Cause.isDieReason(reason) ? [reason.defect] : Cause.isFailReason(reason) ? [reason.error] : [],
  );
  if (errors.length == 1) return errors[0];
  if (errors.length > 1) return new AggregateError(errors, "Workspace runtime failed to close.");
  return Cause.squash(cause);
}
