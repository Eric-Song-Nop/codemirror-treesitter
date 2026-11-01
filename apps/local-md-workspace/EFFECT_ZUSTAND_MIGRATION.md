# Effect and Zustand boundaries

Effect and Zustand are intentionally limited to `apps/local-md-workspace`.
LiveMD, the CodeMirror-compatible packages, and other reusable packages remain
ordinary TypeScript without either dependency.

## Final ownership model

- Zustand vanilla stores own the application read model consumed by React.
- Effect owns the app's asynchronous I/O and resource lifetimes: workspace
  storage and its typed failures, scoped workspace runtimes and their
  serialized replacement, OpenDAL retries and credential renewal, and the
  Dropbox OAuth session (see "Effect architecture" below).
- `WorkspaceDocuments` owns collaborative document identity and lifetime for
  one workspace runtime.
- Each `CollaborativeDocument` owns Loro, browser recovery, external-source
  reconciliation, collaboration transports, and filesystem materialization.
- The plain TypeScript document-view coordinator owns only selected-path
  loading state, stale UI request cancellation, atomic view publication, and
  the selected document subscription.
- TanStack Query owns repeatable workspace tree, directory, and image reads.
- React owns rendering and lifecycle edges that start or dispose app services.

No state container is a second content authority. Zustand projects the selected
document's value and persistence status for rendering; CodeMirror subscribes to
and edits the same Loro-backed document.

## Effect architecture

### Where Effect is used, and where it is not

Effect is the backbone for code whose value comes from typed failures, scoped
resources with guaranteed release, interruption, or declarative retry:
storage I/O, workspace runtime lifetimes, provider authorization, and the
services the UI calls to open workspaces. It is not used for React rendering,
the Zustand read model, the document-view coordinator, collaborative document
internals (`src/lib/workspace/documents`), or synchronous helpers.

Every Effect module exposes Effect-returning functions. Promise APIs exist
only at named boundaries:

- `WorkspaceRuntime` ports (`documentSource`, `tree`, `entries`, `assets`) and
  `WorkspaceRuntime.dispose()` are the Promise facade the document,
  collaboration, and Agent layers consume. Each port method runs exactly one
  Effect program on the services the runtime was built with.
- `src/app/effect-bridge.ts` is the only way UI code runs Effects.

### Services and layers

`src/app/effect-runtime.ts` builds one `ManagedRuntime` from
`workspaceAppLayer`:

| Service                       | Module                                                  | Responsibility                                                                 |
| ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `WorkspaceRuntimeTransitions` | `lib/workspace/runtime/runtime-lifecycle.ts`            | Owns the active workspace runtime's scope; serializes transitions and releases |
| `LocalWorkspaceStorage`       | `lib/workspace/runtime/browser-local-runtime.ts`        | Opens a File System Access folder as a scoped runtime                          |
| `CloudWorkspaceStorage`       | `lib/workspace/runtime/cloud-runtime.ts`                | Opens an OpenDAL cloud workspace as a scoped runtime                           |
| `DropboxWorkspaces`           | `lib/workspace/providers/dropbox/dropbox-workspaces.ts` | Dropbox token cache, single in-flight authorization, Dropbox runtime open      |
| `OpendalOperators`            | `lib/workspace/storage/opendal-operators.ts`            | Opens OpenDAL WASM operators; tests swap it with `OpendalOperators.layerFrom`  |

Below the services, storage is Effect-native: `OpendalOperatorHost.run`
(`storage/opendal-operator-host.ts`) runs one operator call;
`OpendalWorkspaceObjectStore` composes calls into conditional reads and writes
under cross-tab path locks (`storage/workspace-path-lock.ts`, acquired and
released through a scope, interruptible while waiting).

### Scoped workspace runtimes

A runtime is built by `makeScopedWorkspaceRuntime` (`runtime/runtime-scope.ts`):
the operator host, the folder-permission tracker, the document-change monitor,
and the document registry are acquired with their releases in the runtime's
own scope. A failed or interrupted build releases what it already acquired.
Release order is the reverse of acquisition (documents, change monitor,
permission listeners, then the host, which waits for in-flight operator calls
before disposing WASM operators).

`WorkspaceRuntimeTransitions.transition` acquires the next runtime in a scope
forked from the service's layer scope, then (serialized) clears the document
view, publishes the runtime, and closes the replaced runtime's scope. The
candidate is released if opening fails, is interrupted, or activation fails.
`release` deactivates and closes the active runtime when the workspace root
unmounts, and disposing the application runtime closes the active runtime's
scope. Runtime disposal closes the `WorkspaceDocuments` registry, which stops
new edits, flushes every opened document, and releases native resources. A UI
view switch never performs those operations.

Collaborative documents are not Effect-scoped view resources: the registry
keeps them alive independently of which path is selected.

### Error model

Errors that cross module boundaries are `Schema.TaggedError` classes, so Effect
code recovers with `Effect.catchTag`, and Promise callers receive a real
`Error` whose `message` is the same English text the UI and i18n catalog
already map (`lib/workspace/errors.ts`, `lib/i18n.tsx`).

- Storage (`storage/errors.ts`): `WorkspacePermissionDenied`,
  `WorkspaceAuthExpired`, `WorkspaceConflict`, `WorkspaceTransientFailure`,
  `WorkspaceUnsupported`, and `WorkspaceStorageFailure` form the
  `WorkspaceStorageError` union. Each keeps the `code`/`retryable` pair the
  Agent tool contract reports. `WorkspaceHostDisposed`,
  `WorkspaceAuthRenewalFailed` (its `reason` is the provider error),
  `WorkspaceNotFound`, `WorkspaceMutationNotApplied`, and
  `WorkspaceUnsupportedImage` cover the remaining storage and port failures.
- OAuth (`providers/oauth-errors.ts`): `OAuthAuthorizationError` (`reason`:
  popup blocked, closed, denied, timed out, state missing/mismatch, ...),
  `OAuthRequestError` (token exchange or account lookup, with `status` and
  `retryable`), and `WorkspaceAccountChanged`.
- Runtime lifecycle: `WorkspaceRuntimeTransitionError` with the failed
  `operation`.

Programming errors (invalid paths, broken invariants) stay defects.

### Retries and renewal

- OpenDAL calls that are safe to replay (reads, and conditional mutations
  confirmed not applied) retry transient provider failures with
  `opendalTransientRetrySchedule`: exponential from 250ms with jitter, delays
  capped at 4s, at most 3 retries. Unconditional mutations are never replayed.
- The same replayable calls renew expired credentials once. Concurrent
  renewals share one renewal fiber owned by the host scope.
- The Dropbox account lookup retries network failures, 429, and 5xx with
  `dropboxAccountIdentityRetrySchedule`. The PKCE token exchange is never
  retried because an authorization code is single-use.
- `DropboxWorkspaces` runs at most one authorization at a time; waiting callers
  reuse its token. Interrupting an authorization closes its popup.

### Shared-file relay

- `lib/collaboration/share-relay-client.ts` exposes Effect operations (create,
  join, rotate, revoke). Each request is aborted when its fiber is interrupted
  and fails with `ShareRelayNotConfigured`, `ShareRelayRequestError`
  (`reason`: `unauthorized`, `expired`, `rate-limited`, `unavailable`,
  `rejected`; `message` keeps the localized "Could not ... (status)." text), or
  `ShareRelayProtocolError`. The idempotent create replays once on network
  failure or 5xx (`relayShareCreateRetrySchedule`).
- `ShareRelayConnection` keeps a synchronous public API and synchronous frame
  handling (so Loro imports and sends keep their order), while its lifetime is
  an Effect fiber: each WebSocket is a scoped resource whose release removes
  listeners, stops the heartbeat, and closes it; reconnects wait on
  `shareRelayReconnectSchedule` (250ms doubling to 10s plus up to 300ms
  jitter, restarted after a socket opens); a session refresh is an
  interruptible Effect. Socket endings are typed (`ShareRelayConnectionLost`,
  `ShareRelayUnauthorized`, `ShareRelayResyncRequired`,
  `ShareRelaySessionRefreshRequired`, `ShareRelaySessionExpired`,
  `ShareRelaySessionRefreshFailed`). `close()`, `pause()`, and a new
  `connect()` interrupt the fiber, which aborts an in-flight refresh request
  and closes the socket. The wire protocol is unchanged.
- Owner share records (`share-storage.ts`) and the collaboration browser store
  (`collab-browser-store.ts`) remain Promise modules over browser storage;
  `share-storage.ts` reaches the relay operations through injected Promise
  ports whose defaults run the Effects. Hooks run relay Effects through
  `runStandaloneEffect` (service-free effects, same Promise mapping as the
  bridge) with the caller's abort signal.

### Calling Effect from the UI

`runWorkspaceEffect(runtime, effect, { signal })` and the
`useWorkspaceEffectRunner()` hook run an effect on the application runtime;
`runStandaloneEffect(effect, { signal })` runs a service-free effect. The
returned Promise resolves with the value, rejects with the typed failure
itself (or the defect), and rejects with a `DOMException` named `AbortError`
when the effect was interrupted, which existing `isAbortError` checks ignore.
`useWorkspaceEffectRunner` interrupts its effects when the component unmounts.
`WorkspaceEditorSession.replaceWorkspaceRuntime(next, { signal })` accepts a
built runtime or a scoped open effect; its signal cancels opening but not an
already activated transition.

## View transitions

The document-view coordinator uses a standard `AbortSignal` to reject stale UI
preparation. It may publish a loading path, install the latest prepared view,
and unsubscribe the previous view. It does not own a document, persistence
writer, collaboration transport, or source lock.

Atomic Zustand updates ensure React never observes a selected file from one
view with the collaborative document from another. An aborted preparation may
still resolve a registry document; that document remains the canonical cached
instance and requires no candidate cleanup.

## TanStack Query boundary

A Query value must be ordinary data that is safe to refetch, deduplicate,
discard, and garbage-collect by key. Workspace trees, directories, and image
bytes meet that rule. A collaborative document does not: it has stable
workspace/path identity and owns live state and asynchronous persistence, so it
belongs to `WorkspaceDocuments` rather than the query cache.

Mutations may expose pending or error presentation for file operations. They
must not become an alternate Markdown write path; current content changes enter
the collaborative document.

## Dependency boundary

Effect and Zustand must not be imported from `packages/*`, LiveMD, or another
app. App adapters compose framework-neutral workspace and editor contracts at
the `local-md-workspace` boundary. `tools/audit.mjs` enforces this rule.
