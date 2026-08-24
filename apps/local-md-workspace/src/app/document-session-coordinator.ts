import { Context, Effect, Exit, Fiber, FiberSet, Layer, Predicate, Scope, Semaphore } from "effect";
import {
  clearWorkspaceDocumentOpening,
  clearWorkspaceDocumentView,
  publishWorkspaceDocumentOpening,
  publishWorkspaceDocumentView,
  type WorkspaceAppStore,
  type WorkspaceDocumentView,
} from "./workspace-store.ts";
import type { ActiveWorkspaceDocumentSession } from "@/lib/workspace/document-session";

export type WorkspaceDocumentIntentLease = Readonly<{ id: number }>;

export type PreparedWorkspaceDocumentSession = Readonly<{
  activate: () => InstalledWorkspaceDocumentSession;
  dispose: () => Promise<void>;
  view: WorkspaceDocumentView;
}>;

type InstalledWorkspaceDocumentSession = Readonly<{
  release: () => Promise<void>;
  retire: () => void;
  session: ActiveWorkspaceDocumentSession;
}>;

type WorkspaceDocumentTransitionInput = Readonly<{
  lease: WorkspaceDocumentIntentLease;
  prepare: () => Promise<PreparedWorkspaceDocumentSession | null>;
}>;

type WorkspaceDocumentCloseResult = { hadActiveSession: boolean } | null;

type ManagedWorkspaceDocumentSession = InstalledWorkspaceDocumentSession & {
  scope: Scope.Closeable;
};

export type WorkspaceDocumentSessionKernel = {
  active: ManagedWorkspaceDocumentSession | null;
  intentId: number | null;
  store: WorkspaceAppStore;
};

export type WorkspaceDocumentSessionController = {
  begin: (path: string, options?: { activeValue?: string }) => WorkspaceDocumentIntentLease;
  close: (lease?: WorkspaceDocumentIntentLease) => Promise<WorkspaceDocumentCloseResult>;
  current: () => ActiveWorkspaceDocumentSession | null;
  finish: (lease: WorkspaceDocumentIntentLease) => void;
  invalidate: () => void;
  isActive: (session: ActiveWorkspaceDocumentSession) => boolean;
  isCurrent: (lease: WorkspaceDocumentIntentLease) => boolean;
  transition: (
    input: WorkspaceDocumentTransitionInput,
  ) => Promise<ActiveWorkspaceDocumentSession | null>;
};

type WorkspaceDocumentEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, WorkspaceDocumentSessionCoordinator>,
) => Promise<A>;

export function createWorkspaceDocumentSessionKernel(
  store: WorkspaceAppStore,
): WorkspaceDocumentSessionKernel {
  return { active: null, intentId: 0, store };
}

export function createWorkspaceDocumentSessionController(
  kernel: WorkspaceDocumentSessionKernel,
  runPromise: WorkspaceDocumentEffectRunner,
): WorkspaceDocumentSessionController {
  let runCoordinator = <A>(
    action: (
      coordinator: WorkspaceDocumentSessionCoordinator["Service"],
    ) => Effect.Effect<A, Error>,
  ) => runPromise(WorkspaceDocumentSessionCoordinator.use(action));

  return {
    begin(path, options = {}) {
      return issueWorkspaceDocumentIntent(kernel, path, options);
    },
    async close(lease) {
      let closeLease = lease ?? issueWorkspaceDocumentIntent(kernel, null);
      return await runCoordinator((coordinator) => coordinator.close(closeLease));
    },
    current() {
      return kernel.active?.session ?? null;
    },
    finish(lease) {
      clearWorkspaceDocumentOpening(kernel.store, lease.id);
    },
    invalidate() {
      issueWorkspaceDocumentIntent(kernel, null);
    },
    isActive(session) {
      return kernel.active?.session === session;
    },
    isCurrent(lease) {
      return isCurrentDocumentIntent(kernel, lease);
    },
    transition(input) {
      return runCoordinator((coordinator) => coordinator.transition(input));
    },
  };
}

export class WorkspaceDocumentSessionCoordinator extends Context.Service<
  WorkspaceDocumentSessionCoordinator,
  {
    close(lease: WorkspaceDocumentIntentLease): Effect.Effect<WorkspaceDocumentCloseResult, Error>;
    transition(
      input: WorkspaceDocumentTransitionInput,
    ): Effect.Effect<ActiveWorkspaceDocumentSession | null, Error>;
  }
>()("local-md-workspace/WorkspaceDocumentSessionCoordinator") {
  static layer(kernel: WorkspaceDocumentSessionKernel) {
    return Layer.effect(
      WorkspaceDocumentSessionCoordinator,
      Effect.gen(function* () {
        let transitions = yield* FiberSet.make<unknown, Error>();
        let commitGate = yield* Semaphore.make(1);

        let transition = Effect.fn("WorkspaceDocumentSessionCoordinator.transition")(function* (
          input: WorkspaceDocumentTransitionInput,
        ) {
          if (!isCurrentDocumentIntent(kernel, input.lease)) return null;
          let fiber = yield* FiberSet.run(
            transitions,
            prepareAndCommitWorkspaceDocument({ commitGate, input, kernel }),
          );
          return yield* Fiber.join(fiber).pipe(
            Effect.ensuring(
              Effect.sync(() => clearWorkspaceDocumentOpening(kernel.store, input.lease.id)),
            ),
          );
        });

        let close = Effect.fn("WorkspaceDocumentSessionCoordinator.close")(function* (
          lease: WorkspaceDocumentIntentLease,
        ) {
          if (!isCurrentDocumentIntent(kernel, lease)) return null;
          let fiber = yield* FiberSet.run(
            transitions,
            commitGate.withPermit(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  if (!isCurrentDocumentIntent(kernel, lease)) return null;
                  return {
                    hadActiveSession: yield* closeCurrentWorkspaceDocument(
                      kernel,
                      kernel.store.getState().openingDocument?.intentId == lease.id,
                    ),
                  };
                }),
              ),
            ),
          );
          return yield* Fiber.join(fiber);
        });

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            issueWorkspaceDocumentIntent(kernel, null);
            kernel.intentId = null;
            yield* FiberSet.clear(transitions);
            yield* commitGate.withPermit(
              Effect.uninterruptible(
                closeCurrentWorkspaceDocument(kernel, false).pipe(
                  Effect.catchCause(() => Effect.void),
                ),
              ),
            );
          }),
        );

        return WorkspaceDocumentSessionCoordinator.of({ close, transition });
      }),
    );
  }
}

function prepareAndCommitWorkspaceDocument(input: {
  commitGate: Semaphore.Semaphore;
  input: WorkspaceDocumentTransitionInput;
  kernel: WorkspaceDocumentSessionKernel;
}) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      let candidate = yield* tryDocumentSessionPromise(input.input.prepare);
      let scope = yield* Scope.make("sequential");
      if (candidate) {
        yield* Scope.addFinalizer(
          scope,
          tryDocumentSessionPromise(candidate.dispose).pipe(Effect.orDie),
        );
      }
      return { candidate, scope };
    }),
    ({ candidate, scope }) =>
      candidate
        ? input.commitGate.withPermit(
            Effect.uninterruptible(
              commitPreparedWorkspaceDocument({
                candidate,
                candidateScope: scope,
                kernel: input.kernel,
                lease: input.input.lease,
              }),
            ),
          )
        : Effect.succeed(null),
    ({ scope }) =>
      input.kernel.active?.scope === scope ? Effect.void : Scope.close(scope, Exit.void),
  );
}

const commitPreparedWorkspaceDocument = Effect.fn("commitPreparedWorkspaceDocument")(
  function* (input: {
    candidate: PreparedWorkspaceDocumentSession;
    candidateScope: Scope.Closeable;
    kernel: WorkspaceDocumentSessionKernel;
    lease: WorkspaceDocumentIntentLease;
  }) {
    if (!isCurrentDocumentIntent(input.kernel, input.lease)) return null;

    if (input.kernel.active) {
      yield* retireAndCloseWorkspaceDocument(input.kernel, input.kernel.active, true);
    }
    if (!isCurrentDocumentIntent(input.kernel, input.lease)) return null;

    let installed = yield* tryDocumentSessionAction(input.candidate.activate);
    yield* Scope.addFinalizer(
      input.candidateScope,
      tryDocumentSessionPromise(installed.release).pipe(Effect.orDie),
    );
    input.kernel.active = { ...installed, scope: input.candidateScope };

    let publication = yield* Effect.exit(
      tryDocumentSessionAction(() => {
        publishWorkspaceDocumentView(input.kernel.store, input.candidate.view);
      }),
    );
    if (Exit.isFailure(publication)) {
      input.kernel.active = null;
      yield* retireWorkspaceDocumentView(input.kernel, installed, false);
      return yield* Effect.failCause(publication.cause);
    }
    return installed.session;
  },
);

function closeCurrentWorkspaceDocument(
  kernel: WorkspaceDocumentSessionKernel,
  preserveOpening: boolean,
) {
  return Effect.gen(function* () {
    let current = kernel.active;
    if (!current) return false;
    yield* retireAndCloseWorkspaceDocument(kernel, current, preserveOpening);
    return true;
  });
}

const retireAndCloseWorkspaceDocument = Effect.fn("retireAndCloseWorkspaceDocument")(function* (
  kernel: WorkspaceDocumentSessionKernel,
  current: ManagedWorkspaceDocumentSession,
  preserveOpening: boolean,
) {
  kernel.active = null;
  yield* retireWorkspaceDocumentView(kernel, current, preserveOpening).pipe(
    Effect.onExit(() => Scope.close(current.scope, Exit.void)),
  );
});

function retireWorkspaceDocumentView(
  kernel: WorkspaceDocumentSessionKernel,
  current: Pick<InstalledWorkspaceDocumentSession, "retire">,
  preserveOpening: boolean,
) {
  return tryDocumentSessionAction(current.retire).pipe(
    Effect.onExit(() =>
      tryDocumentSessionAction(() => {
        clearWorkspaceDocumentView(kernel.store, preserveOpening);
      }),
    ),
  );
}

function issueWorkspaceDocumentIntent(
  kernel: WorkspaceDocumentSessionKernel,
  path: string | null,
  options: { activeValue?: string } = {},
): WorkspaceDocumentIntentLease {
  if (kernel.intentId == null) {
    throw new Error("The workspace document session coordinator is closed.");
  }

  let lease = { id: ++kernel.intentId } as const;
  if (path == null) {
    let opening = kernel.store.getState().openingDocument;
    if (opening) clearWorkspaceDocumentOpening(kernel.store, opening.intentId);
  } else {
    publishWorkspaceDocumentOpening(
      kernel.store,
      { intentId: lease.id, path },
      options.activeValue,
    );
  }
  return lease;
}

function isCurrentDocumentIntent(
  kernel: WorkspaceDocumentSessionKernel,
  lease: WorkspaceDocumentIntentLease,
) {
  return kernel.intentId == lease.id;
}

function tryDocumentSessionAction<Value>(action: () => Value) {
  return Effect.try({
    try: action,
    catch: workspaceDocumentSessionError,
  });
}

function tryDocumentSessionPromise<Value>(action: () => Promise<Value>) {
  return Effect.tryPromise({
    try: action,
    catch: workspaceDocumentSessionError,
  });
}

function workspaceDocumentSessionError(cause: unknown) {
  return Predicate.isError(cause) ? cause : new Error(String(cause));
}
