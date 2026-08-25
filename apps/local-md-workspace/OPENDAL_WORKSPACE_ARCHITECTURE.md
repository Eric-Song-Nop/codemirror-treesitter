# OpenDAL Workspace Storage Architecture

## Decision

All workspace content I/O uses one provider-neutral path:

```text
BrowserLocal / Dropbox / Google Drive / OneDrive / S3
                         |
                OpenDAL browser operator
                         |
                 operator lifecycle host
                         |
                  workspace object store
                         |
             tree / entries / assets / documents
                         |
                    workspace runtime
                         |
             collaborative documents and views
```

The File System Access API remains responsible for directory selection,
permission checks, handle persistence, dropped-handle path lookup, and change
notifications. It is not an alternate content-storage implementation.

This design deliberately separates:

- exact provider operations from workspace semantics;
- bytes and paths from Markdown product rules;
- storage revisions from Loro frontiers;
- authoritative reads from change hints;
- one storage mutation from autosave scheduling.

## Module Ownership

### Browser OpenDAL package

`packages/opendal-wasm-browser` owns:

- the BrowserLocal OpenDAL `Access` implementation;
- cloud OpenDAL service construction;
- the `wasm-bindgen` boundary;
- generated-value validation and path normalization;
- exact read/write receipts, capabilities, and stable operator errors;
- verified copy/delete fallbacks when native rename is unavailable.

It does not own Markdown rules, React state, OAuth UI, Loro state, document
generations, or autosave scheduling.

The public operator is byte-oriented:

```ts
interface OpendalExactBrowserOperator {
  readonly info: OpendalOperatorInfo;

  stat(path: string): Promise<OpendalMetadata>;
  list(path: string): Promise<OpendalMetadata[]>;
  read(path: string): Promise<OpendalReadResult>;
  write(request: OpendalWriteRequest): Promise<OpendalWriteResult>;
  createDirectory(path: string): Promise<void>;
  delete(request: OpendalDeleteRequest): Promise<OpendalPathMutationResult>;
  rename(request: OpendalRenameRequest): Promise<OpendalPathMutationResult>;
  dispose(): void;
}
```

`read` states whether metadata came from the same read. `write` accepts at most
one explicit condition and states how its metadata was obtained. Path mutations
report `applied`, `partial`, or `unknown` rather than hiding copy/delete failure
windows.

### Operator host

`OpendalOperatorHost` owns operator lifetime.

- BrowserLocal uses a static host tied to one selected directory handle.
- Cloud runtimes use a renewable host tied to provider configuration.
- Reads may be replayed after confirmed authentication expiry.
- A conditional mutation may be replayed only when the provider confirms it
  was not applied.
- Unconditional or indeterminate mutations are never blindly replayed.
- Disposal waits for in-flight work before releasing active and retired WASM
  operators.

### Workspace object store

`OpendalWorkspaceObjectStore` is the only application object-store
implementation. It owns:

- relative path normalization;
- source observation and SHA-256 content hashes;
- atomic revision selection or observed fingerprints;
- explicit commit conditions;
- conflict and indeterminate-outcome translation;
- readback verification;
- path-scoped Web Locks, with an in-page fallback;
- provider capability translation.

Its contract is byte-oriented and has no hidden path-to-revision map:

```ts
interface WorkspaceObjectStore {
  readonly id: string;
  readonly capabilities: WorkspaceObjectStoreCapabilities;

  probe(path: string): Promise<SourceObservation<SourceProbe>>;
  listDirectory(path: string): Promise<WorkspaceEntry[]>;
  read(path: string): Promise<SourceObservation<SourceSnapshot>>;
  commit(request: WorkspaceCommitRequest): Promise<WorkspaceCommitResult>;
  createDirectory(
    path: string,
    condition: WorkspaceTargetCondition,
  ): Promise<WorkspacePathMutationResult>;
  delete(request: WorkspaceDeleteRequest): Promise<WorkspacePathMutationResult>;
  move(request: WorkspaceMoveRequest): Promise<WorkspacePathMutationResult>;
}
```

### Product services and runtime

Focused services above the object store own product rules:

- `OpendalWorkspaceTreeService`: Markdown visibility, sorting, and lazy trees;
- `OpendalWorkspaceEntryService`: names, starter content, create, move, delete;
- `OpendalWorkspaceAssetService`: image validation, allocation, and references;
- `OpendalWorkspaceDocumentService`: UTF-8 text snapshots and commits.

React receives only an assembled `WorkspaceRuntime`:

```ts
type WorkspaceRuntime = {
  identity: WorkspaceIdentity;
  tree: WorkspaceTreePort;
  entries: WorkspaceEntryPort;
  assets: WorkspaceAssetPort;
  documentSource: WorkspaceDocumentPort;
  documents: WorkspaceDocuments;
  currentDocumentChanges: CurrentDocumentChangeSource | null;
  host: WorkspaceHostCapabilities;
  dispose(): Promise<void>;
};
```

Provider configuration, credentials, directory handles, operators, and object
stores stay behind runtime construction. Hooks and components do not import the
object-store implementation.

## Revisions and Observations

A source read returns bytes and the revision describing those bytes:

```ts
type SourceRevision =
  | { kind: "etag" | "version"; validation: "atomic"; value: string }
  | { kind: "fingerprint"; validation: "observed"; value: string };

type SourceSnapshot = {
  bytes: Uint8Array;
  capture: "bound" | "observed";
  contentHash: string;
  metadata: WorkspaceMetadata;
  revision: SourceRevision;
};
```

Dropbox revisions and supported ETags/versions can provide atomic conditions.
BrowserLocal has no atomic compare-and-swap primitive, so it uses observed
fingerprints and never advertises atomic conflict prevention. A successful
BrowserLocal readback proves only what was observed after the write; it cannot
close the underlying API's time-of-check/time-of-use window.

Every commit states its intent:

```ts
type WorkspaceCommitCondition =
  | { kind: "unconditional" }
  | { kind: "if-absent" }
  | { kind: "if-unchanged"; revision: SourceRevision };
```

Results distinguish confirmed durability from conflict and uncertainty:

```ts
type WorkspaceCommitResult =
  | { status: "committed"; revision: SourceRevision }
  | { status: "conflict"; current?: SourceRevision }
  | { status: "unknown"; reconcilePaths: string[] };
```

The caller that owns the read snapshot also owns its revision. The object store
does not infer a base revision from an earlier unrelated call.

## Document Persistence

Each opened collaborative document stores its source baseline beside its Loro
checkpoint. A normalized path resolves to the same document for the entire
workspace lifetime. Source state is explicit:

```ts
type DocumentSourceState =
  | { kind: "present"; baseline: DocumentSourceBaseline }
  | { kind: "missing"; lastPresent?: DocumentSourceBaseline }
  | {
      kind: "unavailable";
      lastPresent?: DocumentSourceBaseline;
      error: WorkspaceStorageError;
    }
  | {
      kind: "recovery-required";
      lastPresent: DocumentSourceBaseline;
      incoming: WorkspaceTextSnapshot;
    };
```

Only `present` permits automatic projection writes. Missing, unavailable,
recovery-required, partial, and unknown states require an authoritative refresh
or an explicit user recovery action.

Each collaborative document owns one coalescing materializer:

- at most one projection write is in flight;
- pending projections collapse to the latest requested state;
- edits remain accepted while a projection is running;
- external observations and source commits share one source-operation queue;
- browser recovery is flushed even when source projection is blocked;
- `flush()` waits for the generation requested before the call, while later
  edits continue in a following projection.

Entry rename and delete preserve path identity: the old-path document remains
alive and observes its missing source, while a renamed destination is a new
path. Runtime disposal closes the entire registry after flushing every opened
document.

## External Changes and Recovery

Every opened document is monitored until the workspace closes.

- BrowserLocal observes the file's immediate parent with a non-recursive
  `FileSystemObserver` when available.
- Cloud sources and BrowserLocal fallback poll each opened path.
- Polling permits one in-flight sample, pauses while hidden, resumes
  immediately, and backs off after failures.
- Online, page-show, and visibility resume events request an immediate resync.
- Switching the selected view does not dispose a document subscription.

Observer records and polling samples are hints. They never update Loro directly.
A hint enters that document's source queue, performs an authoritative document
read, and then reconciles the returned observation.

External content changes are imported as Loro transactions. A dirty document
with an invalid checkpoint or divergent external source enters
`recovery-required`; it is never replaced wholesale. Recovery actions are
explicit: keep a copy, accept the confirmed external value, or recreate a
confirmed-missing source path.

## Locking

Object operations acquire hierarchical path locks under the workspace identity.
Ancestors are shared; mutation targets are exclusive. Multiple target paths are
sorted before acquisition so moves cannot deadlock. Browser Web Locks coordinate
tabs, and the in-page fallback preserves ordering where that API is unavailable.

Locks reduce races among application instances. They do not turn an observed
BrowserLocal revision into provider-level atomic compare-and-swap.

## Persisted Compatibility

Existing collaboration records remain valid when source revision metadata is
absent. Opening performs an authoritative read and establishes a current
revision. Existing materialized hashes keep their checkpoint meaning; they are
not reinterpreted as storage content hashes.

Workspace identities and source aliases preserve existing selected-file,
collaboration, and share records. Credentials, directory handles, generated
operators, and provider clients are never stored in Loro records.

## Invariants

The implementation must preserve these rules:

1. Workspace content has one OpenDAL-backed I/O route.
2. Hooks depend on runtime ports, not operators or object stores.
3. Revisions are explicit and travel with the snapshot that produced them.
4. BrowserLocal observed checks are never described as atomic.
5. An unknown mutation is reconciled, not retried through another path.
6. One workspace path has one collaborative document and one materializer.
7. Change monitors produce hints; authoritative reads produce content.
8. Automatic writes stop when source state is not `present`.
9. Dirty Loro content is never replaced because a checkpoint is invalid.
10. Runtime disposal flushes and closes every opened document before releasing
    its storage host.

## Verification

The storage boundary is covered at four levels:

- Rust unit tests and `wasm32-unknown-unknown` checks;
- TypeScript operator and object-store contract tests;
- workspace runtime, persistence, reconciliation, and hook tests;
- BrowserLocal browser smoke, application UI smoke, and production builds.

Credential-gated provider smoke tests validate real services when their public
OAuth configuration and short-lived credentials are available.
