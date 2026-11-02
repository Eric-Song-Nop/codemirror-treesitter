import { Cause, Effect, Exit, type ManagedRuntime } from "effect";
import { useCallback, useEffect, useRef } from "react";
import type { WorkspaceAppServices } from "@/app/effect-runtime";
import { useWorkspaceApplication } from "@/app/WorkspaceApplicationProvider";

/**
 * The one place UI code runs Effects.
 *
 * React components, hooks, and the editor session call these helpers instead
 * of `Effect.runPromise`, so every program runs on the application's
 * `ManagedRuntime` (and its services). The returned Promise:
 *
 * - resolves with the success value;
 * - rejects with the typed failure itself (a `Schema.TaggedError`, i.e. an
 *   `Error` whose `message` the existing `errorToMessage`/i18n mapping already
 *   understands), or with the defect for unexpected failures;
 * - rejects with a `DOMException` named `AbortError` when the effect was
 *   interrupted, which existing `isAbortError` checks already ignore.
 */
export function runWorkspaceEffect<A, E, R = WorkspaceAppServices>(
  runtime: Pick<ManagedRuntime.ManagedRuntime<R, never>, "runPromiseExit">,
  effect: Effect.Effect<A, E, R>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  return runtime.runPromiseExit(effect, { signal: options.signal }).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    throw promiseRejection(exit.cause);
  });
}

/**
 * Runs an effect that needs no application services (for example a relay HTTP
 * request) with the same Promise mapping as {@link runWorkspaceEffect}.
 * Aborting `signal` interrupts it, which aborts its in-flight requests.
 */
export function runStandaloneEffect<A, E>(
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  return Effect.runPromiseExit(effect, { signal: options.signal }).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    throw promiseRejection(exit.cause);
  });
}

/** Maps a failed Exit's cause to the value a Promise caller should see. */
export function promiseRejection(cause: Cause.Cause<unknown>) {
  if (Cause.hasInterruptsOnly(cause)) {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  return Cause.squash(cause);
}

export type WorkspaceEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, WorkspaceAppServices>,
) => Promise<A>;

/**
 * Returns a stable runner bound to the application runtime whose effects are
 * interrupted when the component unmounts (so scoped resources they acquired
 * are released and late results never reach unmounted UI).
 */
export function useWorkspaceEffectRunner(): WorkspaceEffectRunner {
  let { runtime } = useWorkspaceApplication();
  let controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let controller = new AbortController();
    controllerRef.current = controller;
    return () => {
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  return useCallback(
    <A, E>(effect: Effect.Effect<A, E, WorkspaceAppServices>) => {
      let signal = controllerRef.current?.signal;
      if (signal?.aborted) {
        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      }
      return runWorkspaceEffect<A, E>(runtime, effect, { signal });
    },
    [runtime],
  );
}
