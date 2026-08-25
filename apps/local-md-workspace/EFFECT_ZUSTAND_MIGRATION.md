# Effect and Zustand boundaries

Effect and Zustand are intentionally limited to `apps/local-md-workspace`.
LiveMD, the CodeMirror-compatible packages, and other reusable packages remain
ordinary TypeScript without either dependency.

## Final ownership model

- Zustand vanilla stores own the application read model consumed by React.
- Effect owns serialized workspace-runtime replacement and its typed failures.
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

## Runtime transitions

Workspace runtime replacement remains an Effect service because it must
serialize this operation:

1. Clear the selected UI view and its subscription.
2. Publish the replacement runtime.
3. Dispose the previous runtime.

Runtime disposal closes its `WorkspaceDocuments` registry, which stops new
edits, flushes every opened document, and releases their native resources. A UI
view switch never performs those operations.

The application-level Effect `ManagedRuntime` contains the runtime-transition
service only. Collaborative documents are not Effect-scoped view resources:
the registry keeps them alive independently of which path is selected.

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
