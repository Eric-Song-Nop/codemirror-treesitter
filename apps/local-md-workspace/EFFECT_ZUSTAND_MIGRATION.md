# Effect and Zustand migration

This migration is intentionally limited to `apps/local-md-workspace`. LiveMD,
the CodeMirror-compatible packages, and every other reusable package remain
ordinary TypeScript without Effect or Zustand dependencies.

## Current checkpoint

Phase 1 and the first vertical slice of phase 2 below are implemented. Direct
workspace-document open, switch, close, and save now share one Effect document
session coordinator. A synchronous lease identifies the user's intent; a
scoped candidate is installed only while that lease is current; the previous
persistence fence and collaboration document are finalized from one immutable
session snapshot. The sequential A → B → A regression, stale preparation,
replacement during a slow close, and app disposal during pending work are
covered by deterministic tests.

Zustand intentionally does not expose a large document-phase enum. It retains
the active document projection and one small `openingDocument` marker, so React
can keep the active identity coherent while showing that a newer candidate is
being prepared. The remaining refs and generation counters are compatibility
machinery, not a second intended authority. Rapid outer tree loads, pickers,
sharing, mutations, and standalone-document ownership still need the later
phases below.

## Responsibilities

- Zustand vanilla stores own the application read model consumed by React.
- Effect services own asynchronous orchestration, typed failures,
  interruption, serialization, and resource finalizers.
- TanStack Query owns cacheable, repeatable reads such as workspace trees,
  directories, and image bytes. It does not own live documents or imperative
  resources.
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
5. A stale preparation may finish, but it cannot publish. Any candidate it
   acquired is finalized exactly once.
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
- a `FiberSet` so app disposal waits for pending candidate finalizers;
- a semaphore-serialized commit section guarding one active session;
- a child `Scope` for each candidate; and
- a lease check before commit and again after closing the old session.

## TanStack Query boundary

A Query value must be ordinary data that is safe to refetch, deduplicate,
discard, and garbage-collect by key. Workspace tree/directory reads and image
bytes meet that rule. A collaboration document does not: it owns Loro objects,
subscriptions, pending persistence, and an asynchronous finalizer, and it must
be exclusive with the active session. Consequently there is no document query
key and document open/replace remains an Effect-managed resource transition.

Likewise, `useMutation` may eventually expose pending/error presentation for a
file operation, but it is not the authority for leases, rollback, or session
finalization.

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

- Implemented: introduce the intent/fiber/commit coordinator described above.
- Implemented: migrate direct workspace open, switch, close, collaboration
  document finalization, broadcast cleanup, and save-target capture to the
  coordinator's immutable active session.
- Implemented: remove `loadFileRequestRef` and make app disposal wait for stale
  candidates and active-session finalizers.
- Remaining: move standalone draft/local-file activation, autosave journals,
  source observers, and all remaining resource consumers fully into session
  scopes.
- Remove the remaining active-document generation counters and compatibility
  refs only after all consumers use immutable sessions.

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
