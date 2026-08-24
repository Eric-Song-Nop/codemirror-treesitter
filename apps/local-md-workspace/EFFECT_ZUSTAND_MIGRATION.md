# Effect and Zustand migration

This migration is intentionally limited to `apps/local-md-workspace`. LiveMD,
the CodeMirror-compatible packages, and every other reusable package remain
ordinary TypeScript without Effect or Zustand dependencies.

## Current checkpoint

Phase 1 below is implemented. The sequential A → B → A persistence-fence
regression is covered, but the document intent/session coordinator in phases 2
and 3 is not. The remaining generation refs are compatibility machinery, not
the target architecture; rapid tree loads, pickers, sharing, and mutations must
move through one complete coordinator rather than receive entry-point-specific
race patches.

## Responsibilities

- Zustand vanilla stores own the application read model consumed by React.
- Effect services own asynchronous orchestration, typed failures,
  interruption, serialization, and resource finalizers.
- React owns rendering and the lifecycle edges that start or dispose app
  services. `useEffect` remains appropriate for subscriptions and external
  resource cleanup; it is not used to mirror one state container into another.
- LiveMD and core workspace algorithms stay framework-neutral. Effect adapters
  are composed at the app boundary instead of leaking into editor packages.

## Migration invariants

1. A user intent receives its identity synchronously at the outermost event
   boundary, before a picker, tree read, network request, or document open can
   suspend.
2. Only the latest compatible intent may publish to the Zustand store.
3. One atomic Zustand update publishes a coherent document view. React must
   never observe a selected file from one session and a collaboration document
   from another.
4. Active resources are closed from an immutable session snapshot, never by
   rereading UI state or refs after an `await`.
5. Replaced preparation fibers are interrupted. If a stale operation acquired
   a candidate resource, its finalizer runs exactly once before the winner is
   published.
6. Persistence ownership is released before another session for the same
   workspace path becomes active.
7. App runtime disposal interrupts pending work and waits for finalizers. React
   cleanup starts that disposal but does not pretend that React awaits an async
   cleanup return value.

## Why the active document is not a `ScopedRef`

Effect's current `ScopedRef.set` serializes and makes the complete
acquire-new/close-old/swap operation uninterruptible. That is useful for simple
client replacement, but it cannot express Grove's latest-intent and stale
candidate rules: a slow replacement could still install after a newer intent
arrives.

The document migration therefore uses:

- a synchronous intent lease;
- a keyed `FiberMap` for replaceable preparation work;
- a `SynchronizedRef`-guarded commit section for the active immutable session;
- a child `Scope` or equivalent finalizer ownership for each candidate; and
- a lease check before and after every asynchronous boundary and before atomic
  Zustand publication.

## Phases

### 1. Application foundation

- Install the project-level Effect skill and pinned local Effect source.
- Declare Effect and Zustand only in this app and enforce the boundary in
  `tools/audit.mjs`.
- Move `LocalWorkspaceApp`'s read model to a vanilla Zustand store.
- Remove React-state-to-ref synchronization effects.
- Move serialized workspace runtime replacement to an Effect service backed by
  a managed runtime and semaphore.

### 2. Document session runtime

- Introduce the intent/fiber/commit coordinator described above.
- Migrate open, switch, close, standalone draft activation, autosave ownership,
  and collaboration-document finalization.
- Remove `loadFileRequestRef`, active-document generation counters that have
  become leases, and resource-ownership refs after all consumers use immutable
  sessions.

### 3. Outer document intents

- Take the same document intent before tree refresh, file pickers, Save As,
  startup restore, and shared-draft recovery.
- Ensure slow outer work cannot obtain a newer token after a later user action.

### 4. Sharing and file mutations

- Scope owner hosts and share creation to the immutable document session.
- Migrate rename/delete/create/recovery workflows so stale completion cannot
  clear or reopen a newer document.

### 5. Remaining app workflows

- Migrate startup restore, provider connections, current-document observation,
  and other long-lived app resources to focused Effect services.
- Keep local component-only UI state local when it has no cross-feature or
  asynchronous consistency requirement; Zustand is not a reason to globalize
  every dialog input.
