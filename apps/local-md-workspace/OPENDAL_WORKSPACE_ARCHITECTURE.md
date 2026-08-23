# OpenDAL Workspace Storage Architecture

- Status: Accepted and implemented in the current working tree; revised after
  independent review and implementation validation.
- Scope: browser storage for `local-md-workspace`.
- Target reader: an engineer maintaining or extending workspace storage.
- Post-read action: use these contracts when reviewing or extending workspace
  storage and document reconciliation.
- Detailed execution: see the
  [OpenDAL Workspace Implementation Plan](./OPENDAL_WORKSPACE_IMPLEMENTATION_PLAN.md).

## Decision

Use OpenDAL as the common object-storage abstraction for cloud providers and
user-selected local directories. A browser-local OpenDAL service will accept
the `FileSystemDirectoryHandle` returned by `showDirectoryPicker()` and produce
the same operator interface as Dropbox, Google Drive, OneDrive, and S3.

Separate the system into four semantic levels:

1. `OpendalExactBrowserOperator` exposes exact object operations implemented by
   OpenDAL in WebAssembly.
2. `WorkspaceObjectStore` converts those primitives into stable snapshots,
   explicit revisions, conditional mutations, and stable application errors.
3. Runtime ports select exactly one implementation for each product domain.
4. Document services own Loro reconciliation, current-document monitoring, and
   path-scoped persistence ordering.

Only service construction, authentication, browser permission acquisition,
and native capability reporting may differ between storage providers. The
application must have one high-level storage, document, and persistence path.

## Goals

- Run local and remote workspace objects through the same OpenDAL operator API.
- Make storage revisions explicit values owned by callers, not hidden mutable
  state inside a backend instance.
- Bind content to metadata when the provider exposes a stable token, and label
  weaker observed captures honestly.
- Represent atomic, observed, unsupported, and indeterminate outcomes honestly.
- Use one persistence coordinator for local and remote document projections.
- Observe only the currently open document.
- Keep storage primitives independent of Markdown, Loro, and React.

## Non-goals

- Making all providers expose the same native capabilities.
- Adding watch semantics to OpenDAL itself.
- Recursively observing or polling a workspace.
- Treating File System Access writes as atomic compare-and-swap operations.
- Keeping every workspace file loaded as a Loro document.
- Running synchronization after the browser page closes.
- Exposing provider credentials or browser handles through document APIs.

## Problems in the Pre-migration Shape

The previous browser operator and workspace backend proved the storage path,
but their contracts mixed concerns that need different ownership.

The previous browser operator exposed separate text and byte operations,
optional same-read metadata, three independent optional write conditions, and
an optional write result. A caller cannot rely on every read producing a
revision or every successful write producing a receipt.

The workspace backend combined object operations with product behavior such as
Markdown file creation, image asset naming, tree construction, and browser
handle lookup. Most operations are optional, so callers discover capabilities
through method presence instead of an explicit contract.

The remote workspace backend also owned an implicit `knownRevisions` map and a
write-coalescing queue. A read can change the revision later used by an
unrelated writer, and only the remote path receives the coalescing behavior.

The name `workspace-store` is already used by the application module that
persists workspace registrations, selected paths, provider configuration, and
directory handles. The new byte-and-path port is therefore named
`WorkspaceObjectStore`; it is not a replacement for that registry.

The replacement design keeps object I/O exact and free of caller revision
state, then adds document semantics in deeper application modules.

## Rejected Interface Shapes

### Expose the operator directly to product code

This provides literal API unification, but every tree, document, and asset
caller must understand provider metadata, authentication recovery, stable-read
requirements, and conditional-write selection. It creates one operator type
while duplicating correctness policy across callers.

### Put every operation on one workspace backend

This makes common UI calls convenient, but storage primitives, Markdown
behavior, browser handles, images, collaboration, and capability detection
accumulate on one optional-method interface. The result is a broad, shallow
module that is difficult to validate as a storage contract.

### Expose only stateful document handles

A document handle can own a revision and prevent accidental stale writes, but
it does not model directory listing, assets, or inactive-file operations well.
It also makes storage lifetime depend unnecessarily on one editor session.

The selected design combines a stateless, deep `WorkspaceObjectStore` for all
object operations with a stateful document session above it. The session owns
the active revision and Loro baseline; the object store never does.

## Layer Model

```text
             BrowserLocal OpenDAL service
                         |
             cloud OpenDAL services
                         |
               OpenDAL Rust Operator
                         |
              WebAssembly binding API
                         |
              OpendalExactBrowserOperator
                         |
                OpendalOperatorHost
                         |
                OpendalWorkspaceObjectStore
                         |
        +----------------+----------------+
        |                                 |
 tree/entries/assets             WorkspaceDocumentService
                                          |
                            DocumentPersistenceCoordinator
                                          |
                                     Loro runtime
```

The arrows are dependency directions. Product modules depend on
the focused runtime ports; they do not depend on provider configuration, OAuth
refresh, WASM-generated classes, browser directory handles, or the legacy
`WorkspaceBackend`.

## Layer 1: OpenDAL Service Implementations

Every storage source must construct an OpenDAL `Operator`.

Cloud sources continue to use the corresponding OpenDAL service builders. The
BrowserLocal source is a project-owned OpenDAL service implemented inside the
browser WASM package for the pinned OpenDAL version.

### BrowserLocal service

The upstream OPFS service already implements browser file access in Rust/WASM
with `web_sys::FileSystemDirectoryHandle`. It obtains its root from
`navigator.storage.getDirectory()`, which selects origin-private storage. The
BrowserLocal service instead receives a user-selected directory handle from
JavaScript and retains that handle as its root.

For the pinned OpenDAL `0.57` API, the service implements `opendal::raw::Access`
and provides only capabilities that the browser implementation actually
supports.

```text
BrowserLocalAccess
  root: FileSystemDirectoryHandle

  stat(path)
  read(path)
  write(path)
  list(path)
  create_dir(path)
  delete(path)
  rename(from, to)    when supported or safely emulated
```

Implementation invariants:

- Resolve every path relative to the injected root handle.
- Reject absolute paths, empty file names, `.` and `..` traversal, and embedded
  path separators in individual components.
- Read a file through one browser `File` object so bytes, size, and
  `lastModified` describe the same snapshot.
- Commit a write only when the writable stream closes successfully.
- Attempt a post-write metadata observation after close. If metadata cannot be
  obtained, preserve the applied write receipt with `metadataBinding: "none"`;
  do not pretend the write failed before application.
- Normalize permission and missing-entry failures into OpenDAL errors.
- Report conditional-write capabilities as false. A pre-read comparison does
  not make the underlying write atomic.
- Report file and directory rename independently as native, copy-delete, or
  unsupported through the application capability mapping.

The BrowserLocal service is an OpenDAL service extension, not a separate local
workspace backend. Use of OpenDAL raw APIs remains private to the WASM package
because those APIs can change between OpenDAL minor versions.

## Layer 2: Browser Operator API

The browser package exposes one public operator contract regardless of source.
The generated `wasm-bindgen` class remains an implementation detail behind a
runtime-validating TypeScript facade.

### Construction

Use one public source union and factory:

```ts
export type OpendalBrowserSource =
  | {
      kind: "browser-local";
      rootHandle: FileSystemDirectoryHandle;
    }
  | {
      kind: "dropbox";
      accessToken: string;
      root?: string;
    }
  | {
      kind: "gdrive";
      accessToken: string;
      root?: string;
    }
  | {
      kind: "onedrive";
      accessToken: string;
      root?: string;
    }
  | {
      kind: "s3";
      endpoint: string;
      region: string;
      bucket: string;
      root?: string;
      credentials?: OpendalS3Credentials;
    };

export function openOpendalBrowserOperator(
  source: OpendalBrowserSource,
  runtime?: OpendalBrowserRuntimeOptions,
): Promise<OpendalExactBrowserOperator>;
```

The TypeScript factory may call different generated WASM constructors for a
serializable remote config and a JavaScript directory handle. That difference
does not escape the factory.

### Metadata and capabilities

```ts
export type OpendalEntryKind = "file" | "directory";

export type OpendalMetadata = {
  path: string;
  kind: OpendalEntryKind;
  size?: number;
  lastModified?: string;
  etag?: string;
  version?: string;
};

export type OpendalCapabilities = {
  stat: boolean;
  read: boolean;
  list: boolean;
  write: boolean;
  createDirectory: boolean;
  delete: {
    single: boolean;
    recursive: "native" | "emulated" | "unsupported";
  };
  rename: {
    file: "native" | "copy-delete" | "unsupported";
    directory: "native" | "copy-delete" | "unsupported";
  };
  writeConditions: {
    ifMatch: boolean;
    ifVersion: boolean;
    ifNotExists: boolean;
  };
};

export type OpendalOperatorInfo = {
  scheme: string;
  root: string;
  capabilities: OpendalCapabilities;
};
```

Use one `kind` field instead of redundant `isFile` and `isDirectory` booleans.
Capabilities describe effective behavior exposed by the browser facade, not
only the unwrapped provider's native flags.

### Reads and writes

```ts
export type OpendalReadResult =
  | {
      bytes: Uint8Array;
      metadataBinding: "same-read";
      metadata: OpendalMetadata;
    }
  | {
      bytes: Uint8Array;
      metadataBinding: "none";
    };

export type OpendalWriteCondition =
  | { kind: "if-not-exists" }
  | { kind: "if-match"; etag: string }
  | { kind: "if-version"; version: string };

export type OpendalWriteRequest = {
  path: string;
  bytes: Uint8Array;
  condition?: OpendalWriteCondition;
};

export type OpendalWriteResult =
  | {
      status: "applied";
      metadataBinding: "write-response" | "post-write";
      metadata: OpendalMetadata;
    }
  | {
      status: "applied";
      metadataBinding: "none";
    };

export type OpendalPathMutationResult =
  | { status: "applied" }
  | {
      status: "partial";
      phase: "target-copy" | "source-remove" | "recursive-delete";
      reconcilePaths: string[];
    }
  | { status: "unknown"; reconcilePaths: string[] };

export type OpendalDeleteRequest = {
  path: string;
  recursive: boolean;
};

export type OpendalRenameRequest = {
  from: string;
  to: string;
  kind: "file" | "directory";
};

export interface OpendalExactBrowserOperator {
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

Contract requirements:

- `read` returns exact bytes. It returns metadata only when the adapter can
  prove that metadata came from the same provider response or browser `File`.
- An adapter never combines an independent read and stat while labeling the
  result `same-read`.
- `write` represents one logical mutation request, never coalesces separate
  calls, and returns an honest applied receipt.
- `write-response` metadata came from the provider mutation response;
  `post-write` metadata came from a later observation; `none` reports no
  metadata. Adapters never relabel the latter two as response-bound.
- A discriminated write-condition union prevents contradictory conditions.
- Text encoding and decoding are caller concerns.
- Unsupported operations fail before I/O when capabilities already prove they
  cannot succeed.
- The operator never stores an implicit caller revision.
- The operator never coalesces separate write calls.
- A copy-delete rename reports `partial` when the target may exist but the
  source was not removed. It never compresses that state into a generic error.
- An emulated recursive delete reports `partial` when only part of the subtree
  was removed and includes the subtree root as a reconciliation path.
- A lost response reports `unknown` with every path that must be reconciled.

### Error model

The TypeScript facade translates WASM and provider failures into a stable error
shape:

```ts
export type OpendalErrorCode =
  | "not-found"
  | "already-exists"
  | "condition-failed"
  | "permission-denied"
  | "authentication-expired"
  | "rate-limited"
  | "unsupported"
  | "temporary"
  | "unknown";

export class OpendalBrowserError extends Error {
  readonly code: OpendalErrorCode;
  readonly operation: "stat" | "list" | "read" | "write" | "create-directory" | "delete" | "rename";
  readonly path?: string;
  readonly retryable: boolean;
  readonly mutationOutcome?: "not-applied" | "partial" | "unknown";
  readonly reconcilePaths?: string[];
}
```

Only retry a mutation automatically when the error establishes that it was not
applied. An expired credential or network failure with a partial or unknown
outcome must not trigger a blind replay.

## Layer 3: Operator Lifecycle

Operator construction and credential refresh are runtime concerns, not storage
or document semantics. Hide them behind an internal host:

```ts
type OpendalOperationClass = "read" | "conditional-mutation" | "unconditional-mutation";

interface OpendalOperatorHost {
  readonly identity: WorkspaceStorageIdentity;
  readonly operatorInfo: OpendalOperatorInfo;

  run<T>(input: {
    operation: OpendalOperationClass;
    execute: (operator: OpendalExactBrowserOperator) => Promise<T>;
  }): Promise<T>;
  dispose(): Promise<void>;
}
```

A static host owns the BrowserLocal operator. A renewable host owns cloud
configuration, access-token refresh, and operator recreation. Both expose the
same `run` contract to the workspace object store.

The host may transparently replay reads after a confirmed authentication
failure. It may replay a conditional mutation only when the failure is known
to have occurred before application. It must preserve partial and unknown
mutation outcomes.

The host is internal to the workspace storage implementation. Product callers
never receive an operator or a credential callback.

## Layer 4: Workspace Storage API

`WorkspaceObjectStore` is the application storage port. Implement it once as
`OpendalWorkspaceObjectStore` over an `OpendalOperatorHost`.

Object operations also receive one internal lock dependency:

```ts
type WorkspacePathLockIntent = {
  path: string;
  mode: "shared" | "exclusive";
};

interface WorkspacePathLock {
  run<T>(input: {
    workspaceId: string;
    intents: WorkspacePathLockIntent[];
    execute: () => Promise<T>;
  }): Promise<T>;
}
```

The browser implementation uses Web Locks when available and an in-page keyed
mutex otherwise. It expands each object path into normalized ancestor intents,
deduplicates them using the strongest requested mode, and acquires keys in one
deterministic order.

- Read, probe, and directory listing hold shared locks on the path and its
  ancestors.
- A file commit holds shared ancestor locks and an exclusive file lock.
- Directory creation holds shared ancestor locks and an exclusive target lock.
- Delete and move hold an exclusive lock on each affected subtree root plus the
  required ancestor locks.

This makes a child projection conflict with an app-initiated parent-directory
move or delete. The full preflight/mutation/verification sequence stays inside
the same acquisition, and a source refresh in another application tab cannot
sample the middle of an application mutation.

The lock is non-reentrant. Public methods acquire it once and call private
unlocked capture primitives for preflight and verification; a commit never
calls the public `read` method while holding its exclusive lock.

With Web Locks, this prevents two same-origin application tabs from
interleaving an observed sequence. The fallback protects only one page. Neither
mode coalesces requests, stores revisions, or locks native editors and
third-party clients. Provider conditions remain the only atomic cross-client
protection.

### Revisions and snapshots

```ts
export type SourceRevision =
  | {
      kind: "etag" | "version";
      validation: "atomic";
      value: string;
    }
  | {
      kind: "fingerprint";
      validation: "observed";
      value: string;
    };

export type SourceSnapshot = {
  bytes: Uint8Array;
  capture: "bound" | "observed";
  contentHash: string;
  metadata: WorkspaceMetadata;
  revision: SourceRevision;
};

export type SourceProbe = {
  metadata: WorkspaceMetadata;
  revision?: SourceRevision;
};

export type WorkspaceEntry = {
  path: string;
  kind: "file" | "directory";
  metadata: WorkspaceMetadata;
};

export type SourceObservation<T> =
  | { state: "present"; value: T }
  | { state: "missing" }
  | { state: "unavailable"; error: WorkspaceStorageError };
```

An atomic revision maps to a provider write condition and is accepted only when
the read bytes are bound to that token. An observed fingerprint is derived from
the content hash and relevant metadata. It can detect a change between two
reads but cannot make a later write atomic.

`contentHash` is `sha256:<base64url>` over the exact source bytes, computed with
Web Crypto. The fingerprint uses a versioned canonical encoding of that hash,
entry kind, size, and normalized metadata fields. Do not reuse a non-
cryptographic editor or Loro comparison hash as a storage revision.

Every `present` read returns a revision. A metadata-only probe returns a
revision only when the provider exposes a validation token without reading the
content. BrowserLocal normally omits it, so its monitor must read and hash when
metadata indicates a possible change.

`missing` is a first-class source state, not an operational exception.
`unavailable` covers permission, authentication, transport, and provider
failures for which presence cannot currently be established. Programming and
contract violations may still throw.

There is no backend-wide `knownRevisions` map. The document session or product
service that owns a snapshot must explicitly provide its revision when
committing.

Directory listing preserves every available normalized metadata field,
including size, last-modified time, ETag, and version. Listing metadata is not
content-bound and therefore is not promoted to a source revision. Monitoring
uses `probe` or `read`, never a tree entry as an authoritative baseline.

### Commit contract

```ts
export type WorkspaceCommitCondition =
  | { kind: "unconditional" }
  | { kind: "if-absent" }
  | { kind: "if-unchanged"; revision: SourceRevision };

export type WorkspaceCommitRequest = {
  path: string;
  bytes: Uint8Array;
  condition: WorkspaceCommitCondition;
};

export type WorkspaceCommitResult =
  | {
      status: "committed";
      revision: SourceRevision;
    }
  | {
      status: "conflict";
      current?: SourceRevision;
    }
  | {
      status: "unknown";
      reconcilePaths: string[];
    };

export type WorkspaceExistingPathCondition =
  | { kind: "unconditional" }
  | { kind: "if-unchanged"; revision: SourceRevision };

export type WorkspaceTargetCondition = { kind: "unconditional" } | { kind: "if-absent" };

export type WorkspaceDeleteRequest = {
  path: string;
  recursive?: boolean;
  condition: WorkspaceExistingPathCondition;
};

export type WorkspaceMoveRequest = {
  from: string;
  to: string;
  kind: "file" | "directory";
  sourceCondition: WorkspaceExistingPathCondition;
  targetCondition: WorkspaceTargetCondition;
};

export type WorkspacePathMutationResult =
  | { status: "applied" }
  | {
      status: "conflict";
      path: string;
      reason: "source-changed" | "source-missing" | "target-exists";
      current?: SourceRevision;
    }
  | {
      status: "partial";
      phase: "target-copy" | "source-remove" | "recursive-delete";
      reconcilePaths: string[];
    }
  | { status: "unknown"; reconcilePaths: string[] };
```

The condition is required, including for an intentional unconditional write.
This prevents an omitted revision from silently becoming an overwrite.

Expected concurrency and mutation outcomes are values, not generic exceptions.
Operational failures known not to have applied, such as a pre-operation
permission denial, use a stable `WorkspaceStorageError` translated from
`OpendalBrowserError`.

An unconditional delete is idempotent: an authoritatively missing path is
`applied`. A conditional delete of a missing or changed path is `conflict`.
Move always conflicts when its source is missing, and `if-absent` conflicts
when the target exists.

### Object-store interface

```ts
export type WorkspaceConditionCapability = "atomic" | "observed" | "unsupported";

export type WorkspaceObjectStoreCapabilities = {
  commit: {
    ifUnchanged: WorkspaceConditionCapability;
    ifAbsent: WorkspaceConditionCapability;
  };
  createDirectory: {
    supported: boolean;
    ifAbsent: WorkspaceConditionCapability;
  };
  delete: {
    single: boolean;
    recursive: "native" | "emulated" | "unsupported";
    ifUnchanged: WorkspaceConditionCapability;
  };
  move: {
    file: "native" | "copy-delete" | "unsupported";
    directory: "native" | "copy-delete" | "unsupported";
    sourceIfUnchanged: WorkspaceConditionCapability;
    targetIfAbsent: WorkspaceConditionCapability;
  };
};

export interface WorkspaceObjectStore {
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

Methods are required. An unsupported method reports that state through
capabilities and fails with `unsupported` if called. Callers do not inspect
optional method presence.

`WorkspaceObjectStore` operates on bytes and normalized relative paths.
Markdown defaults, tree node construction, image asset conventions, and UI
naming rules live in product services above it. Existing collaboration
snapshots remain in their browser database; this migration does not invent a
workspace-file persistence service for them.

## Provider Mapping

`OpendalWorkspaceObjectStore` selects the strongest usable source revision
from each read:

1. If the operator returns `same-read` metadata, mark the capture `bound`.
2. Otherwise stat before and after the content read. If the same provider
   version or ETag surrounds the read, bind the bytes to that token.
3. If only weak metadata exists, accept it after a bounded unchanged sample and
   mark the capture `observed`. Retry a changed sample a bounded number of times;
   return `unavailable` when no stable observation can be established.
4. Prefer a bound provider version when conditional version writes are
   supported.
5. Otherwise prefer a bound ETag when conditional ETag writes are supported.
6. Otherwise create an observed fingerprint from content hash and relevant
   metadata.

This is intentionally stronger than the current independent `read + stat`
fallback. That fallback can attach metadata from another object version to the
bytes and must be removed rather than renamed.

For an atomic `if-unchanged` commit, map the revision to the corresponding
OpenDAL write condition. A condition failure becomes `conflict`.

An operator `applied` receipt is not by itself a `committed` object-store
result. The store must also establish the next explicit revision. It may use a
response-bound provider revision or an authoritative readback. If that step
fails or observes an intervening value, return `unknown` and reconcile.

For an observed commit:

1. Read a fresh snapshot immediately before writing.
2. Return `conflict` when its fingerprint differs from the supplied revision.
3. Perform the write.
4. Read back the result and verify the desired content.
5. Return `committed` with the new fingerprint when verification succeeds.
6. Return `unknown` and request reconciliation when the result cannot be
   established.

This procedure detects common local and provider races but is not atomic. The
capability and returned revision must continue to say `observed`.

For BrowserLocal, `committed` means that the requested bytes were observed
after the writable stream closed. It does **not** prove that an external write
was not overwritten between the final pre-read and the write. The File System
Access API supplies no compare-and-swap primitive for a selected directory, so
that time-of-check/time-of-use window cannot be removed by OpenDAL, Web Locks,
or a second read.

Consequences:

- A mismatch detected before writing is a conflict and is never overwritten.
- An atomic cloud revision provides a true no-clobber guarantee.
- An observed BrowserLocal revision provides best-effort detection, not a
  no-clobber guarantee.
- Documentation, capability checks, tests, and UI status must not describe an
  observed commit as atomic.
- A post-write mismatch or ambiguous result becomes `unknown` and blocks more
  automatic projections until authoritative reconciliation.

Delete and move use the same capability discipline. A copy-delete move can
leave both paths present, and a lost response can leave either path state
unknown. The object store returns `partial` or `unknown`; the entry service
re-probes every listed reconciliation path before offering retry or recovery.
The object store may expose file or directory `copy-delete` even when the
operator reports rename unsupported, but only by an explicit emulation that
copies and verifies the target before deleting the source. It never attempts
an automatic rollback after a partial result.
For BrowserLocal, this emulation is also observed: a native editor can change a
source during the copy window, and a directory has no atomic source revision.
The capability must not imply an atomic directory move.

After a partial copy phase, keep the source and partial target and offer an
explicit target cleanup. After a partial source-removal phase, verify the
target before offering removal of the remaining source. An unknown phase offers
no destructive recovery until both roots are authoritatively re-listed.
Directory handles and some providers expose no usable source revision. In that
case conditional source validation is `unsupported`; a destructive directory
operation must carry explicit unconditional intent after product-level
confirmation.

## Product Services Above Storage

Do not carry the current all-purpose workspace backend forward as the storage
port. Split its product behavior into focused consumers of
`WorkspaceObjectStore`:

```text
WorkspaceTreeService
  builds lazy Markdown directory nodes

WorkspaceEntryService
  applies create, move, delete, naming, and starter-content rules

WorkspaceAssetService
  validates and names image assets

WorkspaceDocumentService
  decodes text, owns source baselines, and creates document sessions
```

Loro snapshots remain owned by the existing browser collaboration store, and
share records remain in their existing browser persistence. Neither currently
needs a workspace-object service. Add one only if a concrete workspace-file
format acquires an owner.

### Single-route runtime ports

React hooks receive one assembled set of product ports:

```ts
export type WorkspaceStorageKind =
  | "local"
  | "opendal-dropbox"
  | "opendal-gdrive"
  | "opendal-onedrive"
  | "opendal-s3";

export type WorkspaceIdentity = {
  id: string;
  kind: WorkspaceStorageKind;
  name: string;
  sourceAliases?: WorkspaceSourceAlias[];
};

export type WorkspaceRuntime = {
  identity: WorkspaceIdentity;
  tree: WorkspaceTreePort;
  entries: WorkspaceEntryPort;
  assets: WorkspaceAssetPort;
  documents: WorkspaceDocumentPort;
  currentDocumentChanges: CurrentDocumentChangeSource | null;
  host: WorkspaceHostCapabilities;
  dispose(): Promise<void>;
};
```

The ports are narrow and domain-shaped. The following omits request/result
field definitions but matches the implemented method surface:

```ts
export interface WorkspaceTreePort {
  readTree(): Promise<MarkdownDirectoryNode>;
  readDirectory(path: string, name: string): Promise<MarkdownDirectoryNode>;
  listEntries(path: string): Promise<WorkspaceEntry[]>;
}

export interface WorkspaceEntryPort {
  create(path: string): Promise<string | null>;
  probe(path: string): Promise<SourceObservation<SourceProbe>>;
  move(request: WorkspaceEntryMoveRequest): Promise<WorkspacePathMutationResult>;
  rename(request: WorkspaceEntryRenameRequest): Promise<WorkspaceEntryRenameResult>;
  delete(request: WorkspaceEntryDeleteRequest): Promise<WorkspacePathMutationResult>;
}

export interface WorkspaceAssetPort {
  create(markdownPath: string, image: File): Promise<CreatedWorkspaceImageNode>;
  read(path: string): Promise<Uint8Array>;
  write(request: WorkspaceAssetWriteRequest): Promise<WorkspaceCommitResult>;
  delete(path: string): Promise<WorkspacePathMutationResult>;
}

export interface WorkspaceDocumentPort {
  observe(path: string): Promise<SourceObservation<WorkspaceTextSnapshot>>;
  commit(request: WorkspaceDocumentCommitRequest): Promise<WorkspaceCommitResult>;
}
```

The runtime does not expose an object store. Each provider assembly creates the
store, constructs the narrow services, and returns only these ports. React
hooks therefore cannot bypass document, entry, tree, or asset policy through a
raw `WorkspaceObjectStore` argument. `dispose` first stops change sources and
then retires the operator host after its in-flight operations settle.

Share and BroadcastChannel code receives `WorkspaceIdentity` and the active
document state, not a storage object merely to read its ID or provider kind.
The removed `WorkspaceBackend` abstraction must not be reintroduced; a static
architecture test enforces this production import boundary.

## Document Persistence Coordinator

Storage commits remain exact. Path ordering, projection coalescing, and source
refresh barriers belong in a shared `DocumentPersistenceCoordinator` above
the document service. The coordinator schedules opaque save jobs; each job
performs authoritative source reconciliation and an explicit-revision commit:

```ts
export type DocumentPersistenceOutcome<T> =
  | { status: "completed"; value: T }
  | { status: "superseded"; durableGeneration: number }
  | { status: "blocked"; reason: "closed" | "refresh" }
  | { status: "busy" }
  | { status: "rejected-generation" }
  | { status: "stale" };

export interface DocumentPersistenceCoordinator {
  schedule<T>(input: {
    epoch: number;
    generation: number;
    path: string;
    run: () => Promise<T>;
    sessionId: string;
    workspaceId: string;
  }): Promise<DocumentPersistenceOutcome<T>>;

  barrier(input: { path: string; run: () => Promise<void>; workspaceId: string }): Promise<void>;

  flush(input: { path: string; workspaceId: string }): Promise<void>;

  close(input: {
    epoch?: number;
    path: string;
    sessionId?: string;
    workspaceId: string;
  }): Promise<{ status: "closed" } | { status: "stale" }>;
}
```

Coordinator rules:

- Key a lane only by workspace identity and normalized path.
- Treat session ID plus a monotonically increasing lane epoch as a fencing
  token, never as part of the lane key.
- A new session for the same path receives a busy result until the previous
  session closes. A late close from an older epoch is stale and cannot close
  the new session.
- Keep at most one in-flight projection and one latest pending projection for a
  session epoch.
- If `first`, `second`, and `third` arrive in a burst, persist `first` and then
  `third`, but only when generations are monotonic and each later projection
  represents the complete Loro materialization for that session.
- Reject duplicate or decreasing generations before storage I/O.
- Resolve superseded schedules only after the retained save job completes.
  A superseded result names that job's generation. A projection dropped by a
  refresh barrier resolves `blocked`, never completed or superseded.
- The save job, not the coordinator, owns source revision state. It performs an
  authoritative observation, reconciles Loro, and passes the observed revision
  explicitly to the document service before it can report completion.
- Turn an observer or polling hint into a refresh barrier on the same lane. If
  a commit is in flight, finish determining its outcome, then refresh before
  committing any pending projection.
- Coalesce refresh requests queued behind the same barrier. A hint arriving
  after that barrier starts queues a follow-up barrier, so it cannot be lost.
- Discard a projection materialized before a refresh barrier. Reconciliation
  must produce a new generation and explicit base before writing again.
- Conflict, unknown, missing, and unavailable results are made explicit by the
  save job and document source state. They cannot silently advance the durable
  baseline. A later save must observe and reconcile again.
- `flush` waits until queued work settles. `close` blocks pending projections,
  waits for the current job, and releases the lane. Runtime replacement closes
  the active document before disposing its runtime.
- Do not coalesce different document sessions, create-if-absent operations,
  explicit unrelated revisions, move, delete, or raw inactive-file commits.
- Entry mutations first flush and close a session on the exact path or below an
  affected directory, then execute through `WorkspaceEntryService`.

This coordinator is shared by BrowserLocal and every cloud provider. OpenDAL
does not own Loro generation, refresh barriers, or document-session semantics.

## Current-document Change Detection

Change detection is a side capability beside `WorkspaceObjectStore`, not a
storage operation added to OpenDAL:

```ts
export type CurrentDocumentChangeHint =
  | { kind: "changed" }
  | { kind: "resync-required" }
  | { kind: "monitor-unavailable" };

export interface CurrentDocumentChangeSource {
  subscribe(path: string, onHint: (hint: CurrentDocumentChangeHint) => void): { dispose(): void };
}
```

For BrowserLocal, use `FileSystemObserver` when available. Observe the current
file or its immediate parent without recursion and filter events to the current
path. Observing the parent handles editor save patterns that replace a file via
a temporary sibling.

`resync-required` requests an authoritative refresh while keeping the native
monitor active. `monitor-unavailable` means the hint channel itself stopped or
cannot start; it requests one refresh and switches the active document to the
polling fallback. It is not the same as an `unavailable` source observation.

For a source without native hints, poll only the current path through
`WorkspaceObjectStore.probe`. Compare a returned atomic revision when present.
When the probe has no usable revision, as is typical for BrowserLocal, read and
hash only the current document.

Lifecycle rules:

- Opening a document attempts an authoritative read before accepting a source
  baseline. A persisted Loro document may still open for editing in a blocking
  `unavailable` state, but it cannot project automatically.
- Switching documents disposes the previous source subscription.
- Disposing a subscription suppresses later results and stops timers or native
  observation. It does not claim to cancel an object-store Promise that is
  already awaiting a provider operation.
- Returning to a visible page immediately refreshes the active document.
- Periodic work may pause while hidden.
- Inactive documents are refreshed when opened, not monitored in the
  background.
- The browser closing ends monitoring; persisted baselines drive reconciliation
  on the next open.

A hint never contains authoritative document content. It requests a source
refresh through `DocumentPersistenceCoordinator.barrier`; it does not read
beside an in-flight commit.

## Loro Reconciliation

The active document session owns:

- The latest stable source observation and last present `SourceSnapshot`.
- The source revision used for the next projection commit.
- The corresponding Loro frontier.
- The current Loro document and editor projection.

Its source state is explicit:

```ts
export type DocumentSourceBaseline = {
  contentHash: string;
  revision: SourceRevision;
};

export type DocumentSourceState =
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

Process an external change as follows:

1. Read a source observation through `WorkspaceObjectStore` at a persistence
   lane refresh barrier.
2. For `present`, compare its revision and content hash with the persisted
   source baseline.
3. Ignore a source that already represents this session's committed
   projection.
4. If the persisted checkpoint can be reconstructed, import the external text
   through a forked Loro update and merge it into the active document.
5. If the checkpoint is unusable but Loro is clean relative to the last
   materialization, replace the text through an explicit Loro transaction.
6. If the checkpoint is unusable and Loro is dirty, enter `recovery-required`.
   Preserve both values, publish no replacement, and schedule no projection.
7. Publish a successful logical change to the editor and collaborators.
8. Schedule a new projection only when the reconciled Loro state is not already
   the external source.

Never replace a dirty Loro document directly with source text. Storage hints,
provider events, and local observer records are not Loro operations.

For `missing`, retain the Loro document, stop automatic projection writes, and
offer only an explicit Save As or user-confirmed recreate at the original path.
Never recreate automatically. If the path reappears, reconcile it as a new
present observation before resuming writes.

For `unavailable`, retain the document and pause automatic writes until an
authoritative read succeeds. Permission recovery or authentication renewal
does not imply that the source stayed unchanged.

An external move is treated as `missing` at the original path. Generic object
storage and File System Observer records do not provide a portable identity
proof, so the application does not automatically follow it. An app-initiated
move is different: the entry service closes the old persistence session,
applies the move, verifies both paths, and opens the new path explicitly.

`recovery-required` exposes two explicit exits and no automatic one:

- **Keep local as:** commit the current Loro projection to a user-selected path
  with `if-absent`, verify it, then open that path as a new session.
- **Use external:** after destructive confirmation, apply the incoming source
  through a Loro transaction and adopt its snapshot as the source baseline.

The recovery state retains both values until one action succeeds. A failed or
unknown recovery mutation leaves the state intact and reconciles its affected
paths. Use External performs a final authoritative read; if the incoming
snapshot changed after confirmation was shown, it updates the retained value
and requires a new confirmation.

Inactive documents do not need a live Loro instance. Opening one first reads
its latest source observation. Active Markdown mutations go through Loro;
entry and asset operations that do not target an active document use the
object store through their focused service.

## Delivery Sequence

### Phase 1: Prove the BrowserLocal boundary

- Pass a real selected directory handle into WebAssembly.
- Construct `BrowserLocalAccess` and an OpenDAL Operator.
- Verify list, stat, read, write, create directory, delete, and supported rename
  behavior in Chromium.
- Verify handle restoration and permission revocation.
- Stop if the injected-handle operator cannot satisfy the Layer 2 contract.

### Phase 2: Freeze operator and object-store contracts

- Add contract tests for operator metadata binding, write conditions, mutation
  receipts, partial outcomes, and stable errors.
- Add contract tests for source observations, explicit revisions, commit
  outcomes, and BrowserLocal's observed limitation.
- Do not migrate product behavior yet.

### Phase 3: One workspace object store

- Implement `OpendalWorkspaceObjectStore` once over `OpendalOperatorHost`.
- Run the first cloud provider and BrowserLocal through the same implementation.
- Remove implicit revision state from the storage backend.
- Keep the object store private to final product services.

### Phase 4: Single-route runtime ports

- Introduce final tree, entry, asset, and document ports.
- Rewire React hooks to receive only the assembled runtime ports.
- Remove the broad compatibility backend once callers compile against the
  focused ports; do not retain parallel production routes.

### Phase 5: Document persistence

- Add `DocumentPersistenceCoordinator` with path lanes, epoch fencing, refresh
  barriers, and document-generation-aware coalescing.
- Persist source snapshots and corresponding Loro frontiers.
- Route active document saves through the shared coordinator.

### Phase 6: Product migration

- Move tree, entries, and assets onto the focused product services.

### Phase 7: Current-document reconciliation

- Add local current-file observation with a non-recursive parent fallback.
- Add current-path polling for sources without hints.
- Refresh on open and page resume.
- Feed real external changes into the Loro reconciliation path.

### Phase 8: Provider completion and cleanup

- Move the remaining cloud providers to final product services.
- Remove the compatibility backend after all callers migrate.

## Acceptance Criteria

- BrowserLocal and the first cloud provider produce the same
  `OpendalExactBrowserOperator` contract.
- Both sources use one `OpendalWorkspaceObjectStore` implementation.
- Every source read returns `present`, `missing`, or `unavailable`; every
  present read includes bytes, content hash, metadata, an explicit revision,
  and `bound` or `observed` capture strength.
- No storage backend keeps an implicit revision used as another caller's write
  base.
- Same-origin mutation sequences serialize by normalized workspace path without
  coalescing request identities.
- Every commit declares unconditional, if-absent, or if-unchanged intent.
- Atomic providers enforce no-clobber conditions; BrowserLocal is explicitly
  observed and makes no atomic no-clobber promise.
- Detected conflicts, partial path mutations, and unknown outcomes block blind
  retries and require reconciliation.
- Rapid document projections persist the in-flight state and latest pending
  state without reporting early durability.
- Projection writes and authoritative refreshes share one path lane, with
  session epochs fencing late results.
- Only the active document has an observer or poller.
- A local external edit reaches Loro without directly replacing concurrent
  document state.
- An invalid checkpoint never replaces a dirty Loro document.
- Missing and unavailable active sources pause automatic projection writes.
- Opening an inactive document reads its latest source.
- React hooks receive one runtime implementation per product port and never
  receive the raw object store or operator host.
- Provider credentials, WASM-generated classes, and browser directory handles
  stop at the focused provider/runtime assembly boundary.
- Unsupported provider behavior is visible through capabilities and tests.

## References

- [OpenDAL Operator API](https://opendal.apache.org/docs/rust/opendal/struct.Operator.html)
- [OpenDAL raw service APIs](https://opendal.apache.org/docs/rust/opendal/raw/index.html)
- [OpenDAL capability API](https://opendal.apache.org/docs/rust/opendal/struct.Capability.html)
- [OpenDAL 0.57 OPFS backend](https://github.com/apache/opendal/blob/v0.57.0/core/services/opfs/src/backend.rs)
- [OpenDAL 0.57 OPFS root lookup](https://github.com/apache/opendal/blob/v0.57.0/core/services/opfs/src/utils.rs)
- [FileSystemObserver](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemObserver)
- [Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
