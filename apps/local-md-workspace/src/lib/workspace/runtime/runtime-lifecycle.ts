import { Context, Effect, Layer, Predicate, Schema, Semaphore } from "effect";
import type { WorkspaceRuntime } from "./types.ts";

export type WorkspaceRuntimeTransitionInput = {
  activate: (runtime: WorkspaceRuntime) => void;
  clearDocumentView: () => Promise<void>;
  current: () => WorkspaceRuntime | null;
  next: WorkspaceRuntime;
};

export class WorkspaceRuntimeTransitionError extends Schema.TaggedError<WorkspaceRuntimeTransitionError>()(
  "WorkspaceRuntimeTransitionError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
  },
) {}

export class WorkspaceRuntimeTransitions extends Context.Service<
  WorkspaceRuntimeTransitions,
  {
    transition(
      input: WorkspaceRuntimeTransitionInput,
    ): Effect.Effect<void, WorkspaceRuntimeTransitionError>;
  }
>()("local-md-workspace/WorkspaceRuntimeTransitions") {
  static readonly layer = Layer.effect(
    WorkspaceRuntimeTransitions,
    Effect.gen(function* () {
      let lock = yield* Semaphore.make(1);

      let transition = Effect.fn("WorkspaceRuntimeTransitions.transition")(function* (
        input: WorkspaceRuntimeTransitionInput,
      ) {
        let activated = false;
        let runTransition = lock.withPermit(
          Effect.gen(function* () {
            let current = yield* tryRuntimeValue("read-current-runtime", input.current);
            yield* tryRuntimePromise("clear-document-view", input.clearDocumentView);
            yield* tryRuntimeAction("activate-runtime", () => {
              input.activate(input.next);
              activated = true;
            });

            if (current !== input.next && current) {
              yield* tryRuntimePromise("dispose-replaced-runtime", () => current.dispose());
            }
          }),
        );

        yield* runTransition.pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              let candidateIsCurrent = false;
              try {
                candidateIsCurrent = input.current() === input.next;
              } catch {
                // A broken observer must not prevent candidate cleanup.
              }
              if (activated || candidateIsCurrent) return Effect.void;
              return tryRuntimePromise("dispose-unactivated-runtime", () =>
                input.next.dispose(),
              ).pipe(Effect.catch(() => Effect.void));
            }),
          ),
        );
      });

      return WorkspaceRuntimeTransitions.of({ transition });
    }),
  );
}

export const transitionWorkspaceRuntime = Effect.fn("transitionWorkspaceRuntime")(function* (
  input: WorkspaceRuntimeTransitionInput,
) {
  let transitions = yield* WorkspaceRuntimeTransitions;
  yield* transitions.transition(input);
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
