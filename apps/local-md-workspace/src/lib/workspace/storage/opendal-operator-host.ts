import {
  OpendalBrowserError,
  type OpendalExactBrowserOperator,
  type OpendalOperatorInfo,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { Effect, Fiber, Schedule } from "effect";
import { WorkspaceHostDisposed, type WorkspaceAuthRenewalFailed } from "./errors.ts";
import type { WorkspaceStorageIdentity } from "./types.ts";

export type OpendalOperationClass = "conditional-mutation" | "read" | "unconditional-mutation";

/** What a single OpenDAL operator call can fail with before store translation. */
export type OpendalHostError =
  | OpendalBrowserError
  | WorkspaceAuthRenewalFailed
  | WorkspaceHostDisposed;

export type OpendalHostRequest<T> = {
  execute: (operator: OpendalExactBrowserOperator) => Promise<T>;
  operation: OpendalOperationClass;
};

/**
 * Runs OpenDAL operator calls for one workspace. Hosts are scoped resources:
 * they own their WASM operators and, when their scope closes, stop accepting
 * work, wait for in-flight calls to settle, and only then dispose operators.
 *
 * An operator call that rejects with an `OpendalBrowserError` fails the
 * effect; any other rejection is a defect. Interrupting a caller abandons the
 * wait but not the call itself, which keeps the operator alive until it settles.
 */
export interface OpendalOperatorHost {
  readonly identity: WorkspaceStorageIdentity;
  readonly operatorInfo: OpendalOperatorInfo;

  run<T>(input: OpendalHostRequest<T>): Effect.Effect<T, OpendalHostError>;
}

/**
 * Bounded retry for transient provider failures: exponential from 250ms with
 * jitter, each delay capped at 4s, at most 3 retries.
 */
export const opendalTransientRetrySchedule = Schedule.max([
  Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("4 seconds")]).pipe(
    Schedule.jittered,
  ),
  Schedule.recurs(3),
]);

/**
 * Opens a host around one operator that never changes (browser-local folders).
 * The operator is acquired together with its release, so it is disposed even
 * when later runtime construction fails.
 */
export const makeStaticOpendalOperatorHost = Effect.fn("makeStaticOpendalOperatorHost")(function* <
  E,
>(identity: WorkspaceStorageIdentity, open: Effect.Effect<OpendalExactBrowserOperator, E>) {
  let inflight = new Set<Promise<unknown>>();
  let state = { disposed: false };
  let operator = yield* Effect.acquireRelease(open, (operator) =>
    Effect.gen(function* () {
      state.disposed = true;
      yield* awaitSettled(inflight);
      operator.dispose();
    }),
  );

  let host: OpendalOperatorHost = {
    identity,
    operatorInfo: operator.info,
    run: <T>(input: OpendalHostRequest<T>): Effect.Effect<T, OpendalHostError> =>
      Effect.suspend(
        (): Effect.Effect<T, OpendalHostError> =>
          state.disposed
            ? Effect.fail(WorkspaceHostDisposed.make())
            : callOperator(inflight, operator, input.execute),
      ),
  };
  return host;
});

export type RenewableOpendalOperatorHostOptions = {
  /** Retry policy for transient failures of replayable operations; `null` disables it. */
  retrySchedule?: Schedule.Schedule<unknown, unknown> | null;
};

/**
 * Opens a host whose operator can be replaced when the provider reports expired
 * credentials (cloud workspaces).
 *
 * - A read, or a conditional mutation confirmed not applied, that fails with
 *   `authentication-expired` renews the operator once and is replayed.
 * - Concurrent renewals for the same expired operator share one renewal fiber
 *   owned by the host scope, so one interrupted caller does not cancel it for
 *   the others, and closing the host interrupts it.
 * - The same replayable operations are retried on transient failures with
 *   {@link opendalTransientRetrySchedule}. Unconditional mutations are never
 *   replayed, because a failed attempt may still have been applied.
 */
export const makeRenewableOpendalOperatorHost = Effect.fn("makeRenewableOpendalOperatorHost")(
  function* <E>(input: {
    identity: WorkspaceStorageIdentity;
    open: Effect.Effect<OpendalExactBrowserOperator, E>;
    options?: RenewableOpendalOperatorHostOptions;
    renew: Effect.Effect<OpendalExactBrowserOperator, WorkspaceAuthRenewalFailed>;
  }) {
    let hostScope = yield* Effect.scope;
    let inflight = new Set<Promise<unknown>>();
    let retired = new Set<OpendalExactBrowserOperator>();
    let disposeRetired = () => {
      for (let operator of retired) operator.dispose();
      retired.clear();
    };
    let state: {
      disposed: boolean;
      operator: OpendalExactBrowserOperator;
      renewal: Fiber.Fiber<
        OpendalExactBrowserOperator,
        WorkspaceAuthRenewalFailed | WorkspaceHostDisposed
      > | null;
    } = {
      disposed: false,
      operator: yield* Effect.acquireRelease(input.open, () =>
        Effect.gen(function* () {
          state.disposed = true;
          yield* awaitSettled(inflight);
          disposeRetired();
          state.operator.dispose();
        }),
      ),
      renewal: null,
    };
    let retrySchedule =
      input.options?.retrySchedule === undefined
        ? opendalTransientRetrySchedule
        : input.options.retrySchedule;

    let disposeRetiredIfIdle = Effect.sync(() => {
      if (!inflight.size && !state.disposed) disposeRetired();
    });

    let renewal = (attempted: OpendalExactBrowserOperator) =>
      input.renew.pipe(
        Effect.flatMap((renewed) => {
          if (state.disposed) {
            renewed.dispose();
            return Effect.fail(WorkspaceHostDisposed.make());
          }
          if (renewed !== attempted) retired.add(attempted);
          state.operator = renewed;
          return Effect.succeed(renewed);
        }),
        Effect.ensuring(
          Effect.sync(() => {
            state.renewal = null;
          }),
        ),
      );

    let renewOperator = Effect.fnUntraced(function* (attempted: OpendalExactBrowserOperator) {
      if (state.disposed) return yield* WorkspaceHostDisposed.make();
      if (state.operator !== attempted) return state.operator;
      if (!state.renewal) state.renewal = yield* Effect.forkIn(renewal(attempted), hostScope);
      return yield* Fiber.join(state.renewal);
    });

    let attempt = Effect.fnUntraced(function* <T>(request: OpendalHostRequest<T>) {
      let attempted = state.operator;
      let first = yield* callOperator(inflight, attempted, request.execute).pipe(
        Effect.ensuring(disposeRetiredIfIdle),
        Effect.result,
      );
      if (first._tag == "Success") return first.success;
      if (!canRenewAndReplay(first.failure, request.operation)) {
        return yield* Effect.fail(first.failure);
      }
      let renewed = yield* renewOperator(attempted);
      return yield* callOperator(inflight, renewed, request.execute).pipe(
        Effect.ensuring(disposeRetiredIfIdle),
      );
    });

    let host: OpendalOperatorHost = {
      identity: input.identity,
      get operatorInfo() {
        return state.operator.info;
      },
      run: <T>(request: OpendalHostRequest<T>) => {
        let run: Effect.Effect<T, OpendalHostError> = Effect.suspend(() =>
          state.disposed ? Effect.fail(WorkspaceHostDisposed.make()) : attempt(request),
        );
        if (!retrySchedule) return run;
        return run.pipe(
          Effect.retry(
            retrySchedule.pipe(
              Schedule.setInputType<OpendalHostError>(),
              Schedule.while(({ input: error }) => canRetryTransient(error, request.operation)),
            ),
          ),
        );
      },
    };
    return host;
  },
);

function callOperator<T>(
  inflight: Set<Promise<unknown>>,
  operator: OpendalExactBrowserOperator,
  execute: (operator: OpendalExactBrowserOperator) => Promise<T>,
): Effect.Effect<T, OpendalBrowserError> {
  return Effect.suspend(() => {
    let task = Promise.resolve().then(() => execute(operator));
    inflight.add(task);
    let forget = () => {
      inflight.delete(task);
    };
    task.then(forget, forget);
    return Effect.tryPromise({ catch: (cause) => cause, try: () => task }).pipe(
      Effect.catch((cause) =>
        cause instanceof OpendalBrowserError ? Effect.fail(cause) : Effect.die(cause),
      ),
    );
  });
}

function awaitSettled(inflight: Set<Promise<unknown>>) {
  return Effect.promise(() => Promise.allSettled(inflight));
}

function isReplayable(error: OpendalBrowserError, operation: OpendalOperationClass) {
  if (operation == "read") return true;
  return operation == "conditional-mutation" && error.mutationOutcome == "not-applied";
}

function canRenewAndReplay(error: OpendalHostError, operation: OpendalOperationClass) {
  return (
    error instanceof OpendalBrowserError &&
    error.code == "authentication-expired" &&
    isReplayable(error, operation)
  );
}

function canRetryTransient(error: OpendalHostError, operation: OpendalOperationClass) {
  return error instanceof OpendalBrowserError && error.retryable && isReplayable(error, operation);
}
