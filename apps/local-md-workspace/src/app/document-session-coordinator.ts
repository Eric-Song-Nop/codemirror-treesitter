import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FiberSet,
  Layer,
  Predicate,
  Scope,
  Schema,
  Semaphore,
  SynchronizedRef,
} from "effect";
import {
  clearWorkspaceDocumentOpening,
  clearWorkspaceDocumentView,
  publishWorkspaceDocumentOpening,
  publishWorkspaceDocumentView,
  type WorkspaceAppStore,
} from "./workspace-store.ts";
import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import type { ActiveWorkspaceDocumentSession } from "@/lib/workspace/document-session";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import type { SaveState } from "@/lib/workspace/types";

const documentTransitionKey = "active-document";

export type WorkspaceDocumentIntentLease = Readonly<{
  id: number;
  path: string | null;
}>;

export type PreparedWorkspaceDocumentSession = Readonly<{
  activate: () => InstalledWorkspaceDocumentSession;
  dispose: () => Promise<void>;
  document: CollabDocumentState;
  file: MarkdownFileNode;
  saveState: SaveState;
  value: string;
}>;

export type InstalledWorkspaceDocumentSession = Readonly<{
  release: () => Promise<void>;
  retire: () => void;
  session: ActiveWorkspaceDocumentSession;
}>;

export type WorkspaceDocumentTransitionOutcome =
  | { status: "aborted" }
  | { session: ActiveWorkspaceDocumentSession; status: "activated" }
  | { hadActiveSession: boolean; status: "closed" }
  | { status: "superseded" };

export type WorkspaceDocumentTransitionInput = Readonly<{
  lease: WorkspaceDocumentIntentLease;
  prepare: () => Promise<PreparedWorkspaceDocumentSession | null>;
}>;

export class WorkspaceDocumentSessionError extends Schema.TaggedError<WorkspaceDocumentSessionError>()(
  "WorkspaceDocumentSessionError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
  },
) {}

type ManagedWorkspaceDocumentSession = InstalledWorkspaceDocumentSession & {
  scope: Scope.Closeable;
};

export type WorkspaceDocumentSessionKernel = {
  active: SynchronizedRef.SynchronizedRef<ManagedWorkspaceDocumentSession | null>;
  closed: boolean;
  currentIntentId: number;
  nextIntentId: number;
  store: WorkspaceAppStore;
};

export type WorkspaceDocumentSessionController = {
  begin(path: string, options?: { activeValue?: string }): WorkspaceDocumentIntentLease;
  close(lease?: WorkspaceDocumentIntentLease): Promise<WorkspaceDocumentTransitionOutcome>;
  current(): ActiveWorkspaceDocumentSession | null;
  finish(lease: WorkspaceDocumentIntentLease): void;
  invalidate(): WorkspaceDocumentIntentLease;
  isActive(session: ActiveWorkspaceDocumentSession): boolean;
  isCurrent(lease: WorkspaceDocumentIntentLease): boolean;
  transition(input: WorkspaceDocumentTransitionInput): Promise<WorkspaceDocumentTransitionOutcome>;
};

type WorkspaceDocumentEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, WorkspaceDocumentSessionCoordinator>,
) => Promise<A>;

export function createWorkspaceDocumentSessionKernel(
  store: WorkspaceAppStore,
): WorkspaceDocumentSessionKernel {
  return {
    active: SynchronizedRef.makeUnsafe<ManagedWorkspaceDocumentSession | null>(null),
    closed: false,
    currentIntentId: 0,
    nextIntentId: 0,
    store,
  };
}

export function createWorkspaceDocumentSessionController(
  kernel: WorkspaceDocumentSessionKernel,
  runPromise: WorkspaceDocumentEffectRunner,
): WorkspaceDocumentSessionController {
  let begin = (path: string, options: { activeValue?: string } = {}) =>
    issueWorkspaceDocumentIntent(kernel, path, options);
  let invalidate = () => issueWorkspaceDocumentIntent(kernel, null);

  return {
    begin,
    close(lease) {
      let preserveOpening = lease != null;
      return runPromise(closeWorkspaceDocumentSession(lease ?? invalidate(), { preserveOpening }));
    },
    current() {
      return SynchronizedRef.getUnsafe(kernel.active)?.session ?? null;
    },
    finish(lease) {
      clearWorkspaceDocumentOpening(kernel.store, lease.id);
    },
    invalidate,
    isActive(session) {
      return SynchronizedRef.getUnsafe(kernel.active)?.session === session;
    },
    isCurrent(lease) {
      return isCurrentDocumentIntent(kernel, lease);
    },
    transition(input) {
      return runPromise(transitionWorkspaceDocument(input));
    },
  };
}

export class WorkspaceDocumentSessionCoordinator extends Context.Service<
  WorkspaceDocumentSessionCoordinator,
  {
    close(
      lease: WorkspaceDocumentIntentLease,
      options?: { preserveOpening?: boolean },
    ): Effect.Effect<WorkspaceDocumentTransitionOutcome, WorkspaceDocumentSessionError>;
    transition(
      input: WorkspaceDocumentTransitionInput,
    ): Effect.Effect<WorkspaceDocumentTransitionOutcome, WorkspaceDocumentSessionError>;
  }
>()("local-md-workspace/WorkspaceDocumentSessionCoordinator") {
  static layer(kernel: WorkspaceDocumentSessionKernel) {
    return Layer.effect(
      WorkspaceDocumentSessionCoordinator,
      Effect.gen(function* () {
        let sessionRoot = yield* Scope.fork(yield* Effect.scope, "sequential");
        let latestTransitions = yield* FiberMap.make<
          string,
          WorkspaceDocumentTransitionOutcome,
          WorkspaceDocumentSessionError
        >();
        let inFlightTransitions = yield* FiberSet.make<
          WorkspaceDocumentTransitionOutcome,
          WorkspaceDocumentSessionError
        >();
        let commitGate = yield* Semaphore.make(1);

        let runLatest = Effect.fn("WorkspaceDocumentSessionCoordinator.runLatest")(function* (
          lease: WorkspaceDocumentIntentLease,
          workflow: Effect.Effect<
            WorkspaceDocumentTransitionOutcome,
            WorkspaceDocumentSessionError
          >,
        ) {
          if (!isCurrentDocumentIntent(kernel, lease)) {
            return { status: "superseded" } as const;
          }

          let fiber = yield* FiberSet.run(inFlightTransitions, workflow);
          yield* FiberMap.set(latestTransitions, documentTransitionKey, fiber);
          let exit = yield* Fiber.await(fiber);
          if (Exit.isSuccess(exit)) return exit.value;
          if (Cause.hasInterruptsOnly(exit.cause)) return { status: "superseded" } as const;
          return yield* Effect.failCause(exit.cause);
        });

        let transition = Effect.fn("WorkspaceDocumentSessionCoordinator.transition")(function* (
          input: WorkspaceDocumentTransitionInput,
        ) {
          return yield* runLatest(
            input.lease,
            prepareAndCommitWorkspaceDocument({
              commitGate,
              input,
              kernel,
              sessionRoot,
            }),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                clearWorkspaceDocumentOpening(kernel.store, input.lease.id);
              }),
            ),
          );
        });

        let close = Effect.fn("WorkspaceDocumentSessionCoordinator.close")(function* (
          lease: WorkspaceDocumentIntentLease,
          options: { preserveOpening?: boolean } = {},
        ) {
          return yield* runLatest(
            lease,
            commitGate.withPermit(
              Effect.uninterruptible(
                closeCurrentWorkspaceDocument(kernel, options.preserveOpening ?? false),
              ),
            ),
          );
        });

        yield* Scope.addFinalizer(
          yield* Effect.scope,
          Effect.gen(function* () {
            kernel.closed = true;
            issueWorkspaceDocumentIntent(kernel, null, { allowClosed: true });
            yield* FiberSet.clear(inFlightTransitions);
            yield* commitGate.withPermit(
              Effect.uninterruptible(
                closeCurrentWorkspaceDocument(kernel, false).pipe(Effect.catch(() => Effect.void)),
              ),
            );
            yield* Scope.close(sessionRoot, Exit.void);
          }),
        );

        return WorkspaceDocumentSessionCoordinator.of({ close, transition });
      }),
    );
  }
}

export const transitionWorkspaceDocument = Effect.fn("transitionWorkspaceDocument")(function* (
  input: WorkspaceDocumentTransitionInput,
) {
  let coordinator = yield* WorkspaceDocumentSessionCoordinator;
  return yield* coordinator.transition(input);
});

export const closeWorkspaceDocumentSession = Effect.fn("closeWorkspaceDocumentSession")(function* (
  lease: WorkspaceDocumentIntentLease,
  options: { preserveOpening?: boolean } = {},
) {
  let coordinator = yield* WorkspaceDocumentSessionCoordinator;
  return yield* coordinator.close(lease, options);
});

function prepareAndCommitWorkspaceDocument(input: {
  commitGate: Semaphore.Semaphore;
  input: WorkspaceDocumentTransitionInput;
  kernel: WorkspaceDocumentSessionKernel;
  sessionRoot: Scope.Scope;
}) {
  let handedOff = false;

  return Effect.scoped(
    Effect.gen(function* () {
      let candidateScope = yield* Effect.acquireRelease(
        Scope.fork(input.sessionRoot, "sequential"),
        (scope) => (handedOff ? Effect.void : Scope.close(scope, Exit.void)),
      );
      let candidate = yield* Scope.provide(candidateScope)(
        Effect.acquireRelease(
          tryDocumentSessionPromise("prepare-document", input.input.prepare),
          (prepared) =>
            prepared
              ? tryDocumentSessionPromise("dispose-candidate-document", prepared.dispose).pipe(
                  Effect.orDie,
                )
              : Effect.void,
        ),
      );
      if (!candidate) return { status: "aborted" } as const;

      return yield* input.commitGate.withPermit(
        Effect.uninterruptible(
          commitPreparedWorkspaceDocument({
            candidate,
            candidateScope,
            handoff: () => {
              handedOff = true;
            },
            kernel: input.kernel,
            lease: input.input.lease,
          }),
        ),
      );
    }),
  );
}

const commitPreparedWorkspaceDocument = Effect.fn("commitPreparedWorkspaceDocument")(
  function* (input: {
    candidate: PreparedWorkspaceDocumentSession;
    candidateScope: Scope.Closeable;
    handoff: () => void;
    kernel: WorkspaceDocumentSessionKernel;
    lease: WorkspaceDocumentIntentLease;
  }) {
    if (!isCurrentDocumentIntent(input.kernel, input.lease)) {
      return { status: "superseded" } as const;
    }

    let current = SynchronizedRef.getUnsafe(input.kernel.active);
    if (current) {
      yield* retireAndCloseWorkspaceDocument(input.kernel, current, true);
    }
    if (!isCurrentDocumentIntent(input.kernel, input.lease)) {
      return { status: "superseded" } as const;
    }

    let installed = yield* tryDocumentSessionAction("activate-document", input.candidate.activate);
    yield* Scope.addFinalizer(
      input.candidateScope,
      tryDocumentSessionPromise("release-active-document", installed.release).pipe(Effect.orDie),
    );

    yield* SynchronizedRef.set(input.kernel.active, {
      ...installed,
      scope: input.candidateScope,
    });

    let publication = yield* Effect.exit(
      tryDocumentSessionAction("publish-document", () => {
        publishWorkspaceDocumentView(input.kernel.store, {
          document: input.candidate.document,
          file: input.candidate.file,
          saveState: input.candidate.saveState,
          value: input.candidate.value,
        });
      }),
    );
    if (Exit.isFailure(publication)) {
      yield* SynchronizedRef.set(input.kernel.active, null);
      yield* retireWorkspaceDocumentView(input.kernel, installed, false);
      return yield* Effect.failCause(publication.cause);
    }

    input.handoff();
    return { session: installed.session, status: "activated" } as const;
  },
);

function closeCurrentWorkspaceDocument(
  kernel: WorkspaceDocumentSessionKernel,
  preserveOpening: boolean,
) {
  return Effect.gen(function* () {
    let current = SynchronizedRef.getUnsafe(kernel.active);
    if (!current) return { hadActiveSession: false, status: "closed" } as const;

    yield* retireAndCloseWorkspaceDocument(kernel, current, preserveOpening);
    return { hadActiveSession: true, status: "closed" } as const;
  });
}

const retireAndCloseWorkspaceDocument = Effect.fn("retireAndCloseWorkspaceDocument")(function* (
  kernel: WorkspaceDocumentSessionKernel,
  current: ManagedWorkspaceDocumentSession,
  preserveOpening: boolean,
) {
  yield* SynchronizedRef.set(kernel.active, null);
  let retirement = yield* Effect.exit(
    retireWorkspaceDocumentView(kernel, current, preserveOpening),
  );
  let closure = yield* Effect.exit(Scope.close(current.scope, Exit.void));

  if (Exit.isFailure(retirement)) return yield* Effect.failCause(retirement.cause);
  if (Exit.isFailure(closure)) {
    return yield* documentSessionError("close-active-document", Cause.squash(closure.cause));
  }
});

function retireWorkspaceDocumentView(
  kernel: WorkspaceDocumentSessionKernel,
  current: Pick<InstalledWorkspaceDocumentSession, "retire">,
  preserveOpening: boolean,
) {
  return Effect.gen(function* () {
    let retirement = yield* Effect.exit(
      tryDocumentSessionAction("retire-document", current.retire),
    );
    let publication = yield* Effect.exit(
      tryDocumentSessionAction("clear-document-view", () => {
        clearWorkspaceDocumentView(kernel.store, { preserveOpening });
      }),
    );
    if (Exit.isFailure(retirement)) return yield* Effect.failCause(retirement.cause);
    if (Exit.isFailure(publication)) return yield* Effect.failCause(publication.cause);
  });
}

function issueWorkspaceDocumentIntent(
  kernel: WorkspaceDocumentSessionKernel,
  path: string | null,
  options: { activeValue?: string; allowClosed?: boolean } = {},
): WorkspaceDocumentIntentLease {
  if (kernel.closed && !options.allowClosed) {
    throw new Error("The workspace document session coordinator is closed.");
  }

  let lease = { id: ++kernel.nextIntentId, path } as const;
  kernel.currentIntentId = lease.id;
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
  return !kernel.closed && kernel.currentIntentId == lease.id;
}

function tryDocumentSessionAction<Value>(operation: string, action: () => Value) {
  return Effect.try({
    try: action,
    catch: (cause) => workspaceDocumentSessionError(operation, cause),
  });
}

function tryDocumentSessionPromise<Value>(operation: string, action: () => Promise<Value>) {
  return Effect.tryPromise({
    try: action,
    catch: (cause) => workspaceDocumentSessionError(operation, cause),
  });
}

function documentSessionError(operation: string, cause: unknown) {
  return Effect.fail(workspaceDocumentSessionError(operation, cause));
}

function workspaceDocumentSessionError(operation: string, cause: unknown) {
  return new WorkspaceDocumentSessionError({
    cause,
    message: Predicate.isError(cause) ? cause.message : String(cause),
    operation,
  });
}
