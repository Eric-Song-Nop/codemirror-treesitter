import { Context, Effect, Exit, Layer, Predicate, Schema, Scope, Semaphore } from "effect";
import { adoptWorkspaceRuntime, releaseFailure } from "./runtime-scope.ts";
import type { WorkspaceRuntime } from "./types.ts";

export type WorkspaceRuntimeTransitionInput<E = never, R = never> = {
  activate: (runtime: WorkspaceRuntime) => void;
  clearDocumentView: () => Promise<void>;
  current: () => WorkspaceRuntime | null;
  /**
   * The runtime to activate: either an already built runtime (adopted, its
   * `dispose()` becomes its release) or a scoped effect that acquires one.
   */
  next: Effect.Effect<WorkspaceRuntime, E, R | Scope.Scope> | WorkspaceRuntime;
};

export type WorkspaceRuntimeReleaseInput = {
  current: () => WorkspaceRuntime | null;
  deactivate: () => void;
};

export class WorkspaceRuntimeTransitionError extends Schema.TaggedError<WorkspaceRuntimeTransitionError>()(
  "WorkspaceRuntimeTransitionError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
  },
) {}

/**
 * Owns the active workspace runtime's lifetime.
 *
 * Each transition acquires the next runtime in a fresh scope forked from this
 * service's layer scope, clears the document view, activates the runtime, and
 * then closes the replaced runtime's scope. Transitions and releases are
 * serialized. A candidate that fails to build, fails to activate, or is
 * interrupted (including by application runtime disposal) is released before
 * the transition settles, and disposing the application runtime releases the
 * active runtime.
 */
export class WorkspaceRuntimeTransitions extends Context.Service<
  WorkspaceRuntimeTransitions,
  {
    transition<E, R>(
      input: WorkspaceRuntimeTransitionInput<E, R>,
    ): Effect.Effect<
      WorkspaceRuntime,
      E | WorkspaceRuntimeTransitionError,
      Exclude<R, Scope.Scope>
    >;
    release(
      input: WorkspaceRuntimeReleaseInput,
    ): Effect.Effect<void, WorkspaceRuntimeTransitionError>;
  }
>()("local-md-workspace/WorkspaceRuntimeTransitions") {
  static readonly layer = Layer.effect(
    WorkspaceRuntimeTransitions,
    Effect.gen(function* () {
      let lock = yield* Semaphore.make(1);
      let layerScope = yield* Effect.scope;
      let scopes = new Map<WorkspaceRuntime, Scope.Closeable>();

      let releaseRuntime = (operation: string, runtime: WorkspaceRuntime) => {
        let scope = scopes.get(runtime);
        scopes.delete(runtime);
        let close = scope
          ? Scope.close(scope, Exit.void)
          : Effect.tryPromise({ catch: (cause) => cause, try: () => runtime.dispose() }).pipe(
              Effect.orDie,
            );
        return close.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(runtimeTransitionError(operation, releaseFailure(cause))),
          ),
        );
      };

      let transition = Effect.fn("WorkspaceRuntimeTransitions.transition")(function* <E, R>(
        input: WorkspaceRuntimeTransitionInput<E, R>,
      ) {
        let candidateScope = yield* Scope.fork(layerScope, "sequential");
        let activated = false;
        let reused = false;
        let next: WorkspaceRuntime | null = null;

        let run = Effect.gen(function* () {
          // Acquire before waiting for the permit, so an interrupted wait still
          // releases the candidate through its scope.
          let candidate = yield* (
            Effect.isEffect(input.next)
              ? input.next
              : adoptWorkspaceRuntime(input.next, () => !reused)
          ).pipe(Scope.provide(candidateScope));
          next = candidate;
          return yield* lock.withPermit(
            Effect.gen(function* () {
              let current = yield* tryRuntimeValue("read-current-runtime", input.current);
              yield* tryRuntimePromise("clear-document-view", input.clearDocumentView);
              yield* tryRuntimeAction("activate-runtime", () => {
                input.activate(candidate);
                activated = true;
              });

              if (current === candidate) {
                // Reusing the active runtime keeps its existing scope.
                reused = true;
                yield* Scope.close(candidateScope, Exit.void);
                return candidate;
              }
              scopes.set(candidate, candidateScope);
              if (current) yield* releaseRuntime("dispose-replaced-runtime", current);
              return candidate;
            }),
          );
        });

        return yield* run.pipe(
          Effect.onExit((exit) => {
            let candidateIsCurrent = false;
            try {
              candidateIsCurrent = next !== null && input.current() === next;
            } catch {
              // A broken observer must not prevent candidate cleanup.
            }
            if (activated || candidateIsCurrent) return Effect.void;
            if (next) scopes.delete(next);
            return Scope.close(candidateScope, exit).pipe(Effect.ignoreCause);
          }),
        );
      });

      let release = Effect.fn("WorkspaceRuntimeTransitions.release")(function* (
        input: WorkspaceRuntimeReleaseInput,
      ) {
        yield* lock.withPermit(
          Effect.gen(function* () {
            let current = yield* tryRuntimeValue("read-current-runtime", input.current);
            yield* tryRuntimeAction("deactivate-runtime", input.deactivate);
            if (current) yield* releaseRuntime("dispose-released-runtime", current);
          }),
        );
      });

      return WorkspaceRuntimeTransitions.of({ release, transition });
    }),
  );
}

export const transitionWorkspaceRuntime = Effect.fn("transitionWorkspaceRuntime")(function* <E, R>(
  input: WorkspaceRuntimeTransitionInput<E, R>,
) {
  let transitions = yield* WorkspaceRuntimeTransitions;
  return yield* transitions.transition(input);
});

export const releaseWorkspaceRuntime = Effect.fn("releaseWorkspaceRuntime")(function* (
  input: WorkspaceRuntimeReleaseInput,
) {
  let transitions = yield* WorkspaceRuntimeTransitions;
  yield* transitions.release(input);
});

function tryRuntimeAction(operation: string, action: () => void) {
  return tryRuntimeValue(operation, action);
}

function tryRuntimeValue<Value>(operation: string, action: () => Value) {
  return Effect.try({
    try: action,
    catch: (cause) => runtimeTransitionError(operation, cause),
  });
}

function tryRuntimePromise(operation: string, action: () => Promise<void>) {
  return Effect.tryPromise({
    try: action,
    catch: (cause) => runtimeTransitionError(operation, cause),
  });
}

function runtimeTransitionError(operation: string, cause: unknown) {
  return new WorkspaceRuntimeTransitionError({
    cause,
    message: Predicate.isError(cause) ? cause.message : String(cause),
    operation,
  });
}
