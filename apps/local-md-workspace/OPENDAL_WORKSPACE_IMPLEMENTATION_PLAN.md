# OpenDAL Workspace Implementation Plan

- Status: Implemented in the current working tree; retained as the stacked pull
  request and review plan for landing the migration.
- Scope: migrate browser-local and cloud workspace storage to the architecture
  defined in the OpenDAL workspace storage record.
- Target reader: an engineer implementing or reviewing one pull request in the
  migration.
- Post-read action: split or review the working-tree implementation along these
  dependency boundaries and preserve each proof gate while landing it.

## Implementation Outcome

The working tree now contains the final architecture directly: BrowserLocal and
cloud runtimes construct the exact OpenDAL operator, all workspace content I/O
passes through `OpendalWorkspaceObjectStore`, React consumes focused runtime
ports, source revisions are explicit, and the broad `WorkspaceBackend` plus its
implicit revision map and write queue have been removed.

The final implementation also includes the document persistence coordinator,
explicit missing/unavailable/recovery states, non-recursive active-file
`FileSystemObserver` integration, active-file polling fallback, recovery UI,
provider token-renewal policy, and lifecycle ordering for workspace switches
and entry mutations. The temporary rollout profiles described below were not
kept because the requested implementation proceeded to the final cutover in one
working tree. The stack boundaries remain the recommended way to review and
land the change as stacked pull requests.

## Executive Summary

This is an architecture migration, not a small interface refactor. The current
`WorkspaceBackend` type is referenced by dozens of application and test modules.
It currently connects browser handles, cloud authentication, object operations,
Markdown tree behavior, image assets, Loro persistence, sharing, and autosave.

The migration therefore uses four separately merged pull request stacks. Each
stack leaves the application in a supported state. The next stack starts only
after the previous stack has merged and its checkpoint has been exercised.

```text
Stack A: storage substrate
  baseline -> BrowserLocal service -> operator contract -> workspace object store

Stack B: document persistence
  runtime ports -> source observations -> reconciliation states -> persistence coordinator

Stack C: local product cutover and change detection
  tree/actions -> assets -> observer -> polling fallback

Stack D: provider completion and legacy removal
  remaining providers -> compatibility removal
```

The revised topology contains fourteen pull requests. A pull request must be
split further before submission when it crosses the size guardrails in this
plan. The number of pull requests is not a delivery target; small, reviewable,
independently provable changes are.

## Scope Boundaries

This migration includes:

- A BrowserLocal OpenDAL service backed by an injected
  `FileSystemDirectoryHandle`.
- One exact browser operator API for local and cloud sources.
- One provider-neutral `WorkspaceObjectStore` with explicit observations,
  revisions, conditional mutations, and indeterminate outcomes.
- Explicit storage snapshots owned by document sessions.
- One document persistence coordinator shared by local and cloud sources.
- Non-recursive change detection for only the active document.
- Migration of existing tree, entry, asset, and document behavior to focused
  services above `WorkspaceObjectStore`.
- Removal of the broad compatibility backend after all callers migrate.

This migration does not include:

- Recursive workspace observation or full-tree polling.
- Background synchronization after the page closes.
- A promise of atomic compare-and-swap for browser-local files.
- Automatic recovery from an undetectable BrowserLocal write race.
- New cloud providers or new user-facing provider flows.
- A workspace UI redesign.
- Moving existing IndexedDB collaboration snapshots or localStorage share
  records into workspace files.

## Baseline That Must Not Regress

Before changing production behavior, add characterization coverage for the
following existing behavior.

### Workspace identity and persistence

- A remembered local directory reopens with the same workspace identity.
- Cloud account, drive, and root identity remain stable.
- Existing selected-file state and Loro document IDs continue to resolve.
- Existing collaboration records can be reopened without data migration loss.
- Provider credentials and browser handles never enter Loro document records.

### Local workspace behavior

- Open and restore a selected directory.
- Lazy-list Markdown folders while hiding internal state and ignored build
  directories.
- Create, rename, and delete Markdown files and directories.
- Read and write text and binary assets.
- Allocate image names and Markdown references without overwriting an existing
  image.
- Resolve a dropped browser file handle back to a workspace path.
- Surface permission revocation and missing entries without clearing user data.

### Cloud workspace behavior

- Refresh access tokens and recreate the operator after confirmed expiry.
- Preserve provider root and identity.
- Use atomic no-clobber and revision writes where the provider supports them.
- Do not retry a write when its outcome may already be durable.
- Preserve the current Dropbox, Google Drive, and OneDrive startup flows.

### Document and collaboration behavior

- Open a new Loro document from the current source file.
- Reopen a persisted Loro document and reconcile an external source edit.
- Preserve the existing checkpoint-based fork/import path for external edits.
- Characterize the current invalid-checkpoint fallback that replaces dirty
  Loro text; do not encode that unsafe fallback as desired behavior.
- Persist Loro snapshots and update logs.
- Preserve BroadcastChannel and owner relay behavior.
- Flush the active document before rename, delete, workspace switch, and page
  lifecycle transitions.
- Keep the current save-state and conflict error behavior until the named
  reconciliation-state pull request explicitly replaces it.

### Build and delivery behavior

- The OpenDAL WebAssembly package builds from a clean checkout.
- The production bundle includes the generated WebAssembly closure and passes
  the bundle contract.
- The service worker precache remains complete.
- The local, sharing, conflict, and Dropbox UI smoke flows continue to pass.

At planning time the application baseline is 50 test files and 299 passing
tests. Treat that number as a reference, not a fixed assertion; new tests should
increase it.

## Final Module Ownership

The migration is complete only when ownership matches the following model.

### Browser OpenDAL package

The browser package owns:

- The BrowserLocal OpenDAL `Access` implementation.
- Cloud OpenDAL service construction.
- The `wasm-bindgen` boundary.
- Runtime validation of generated values.
- Exact object bytes, honest same-read metadata binding, write conditions,
  receipts, capabilities, and stable operator errors.

It does not own Markdown rules, Loro state, document generations, React state,
OAuth UI, or change monitoring.

### Operator host

`OpendalOperatorHost` owns operator lifetime.

- A static host owns a BrowserLocal operator and its selected root handle.
- A renewable host owns cloud configuration, token refresh, and operator
  recreation.
- Confirmed pre-operation authentication failures may be retried.
- Partial and unknown mutation outcomes are never retried as ordinary failures.

### Workspace object store

`OpendalWorkspaceObjectStore` is the only final object-storage implementation.
It works with bytes and normalized relative paths. The name deliberately does
not collide with the existing workspace registry module.

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

The object store owns revision selection, observed conflict checks, post-write
verification, partial/unknown mutation reporting, and translation of operator
errors. It has no hidden path-to-revision map and no document write queue.

### Product services

Focused product services consume `WorkspaceObjectStore`:

- `WorkspaceTreeService` applies Markdown visibility, sorting, and lazy tree
  rules.
- `WorkspaceEntryService` applies file and directory naming, starter content,
  move, and delete workflows.
- `WorkspaceAssetService` validates images, allocates names, and produces
  Markdown references.
- `WorkspaceDocumentService` decodes source text, opens document sessions, and
  reconciles storage outcomes.

Existing collaboration snapshots stay in the browser collaboration database,
and existing share records stay in browser key-value persistence. They do not
gain a workspace-object service in this migration.

Browser-only handle lookup and change observation are host capabilities beside
these services. They are not alternate content-storage implementations.

### Workspace runtime

The React application receives one assembled runtime per opened workspace.

```ts
type WorkspaceRuntime = {
  identity: WorkspaceIdentity;
  tree: WorkspaceTreePort;
  entries: WorkspaceEntryPort;
  assets: WorkspaceAssetPort;
  documents: WorkspaceDocumentPort;
  currentDocumentChanges: CurrentDocumentChangeSource | null;
  host: WorkspaceHostCapabilities;
};
```

Provider configuration, tokens, generated WebAssembly classes, and browser
directory handles remain behind runtime construction. The object store and
legacy backend are also assembly internals. React hooks cannot receive either
one directly.

Each port has two temporary implementations: a legacy adapter and a final
service. Runtime assembly chooses exactly one implementation per port from the
rollout profile. The chosen implementation cannot change until the workspace
runtime is disposed.

### Document session

An active document session owns the relationship between source storage and
Loro.

```ts
type DocumentSourceBaseline = {
  contentHash: string;
  revision: SourceRevision;
};

type DocumentSessionSource =
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
      incoming: SourceSnapshot;
    };

type DocumentSession = {
  id: string;
  path: string;
  source: DocumentSessionSource;
  sourceFrontiers: SerializedCollabFrontier[];
  collabDocument: CollabDocumentState;
};
```

The document session, not the backend, advances the source revision after a
confirmed commit or authoritative refresh. Missing, unavailable, and recovery
states block automatic projection writes.

## Migration Safety Rules

These rules apply to every pull request.

1. **One route per product port.** Legacy and final implementations may coexist
   in the bundle, but a constructed runtime exposes exactly one tree, entry,
   asset, and document port. Hooks never receive raw legacy and final paths
   together.
2. **Select a rollout profile at workspace open.** Do not switch storage
   implementations after an operation starts. Close and reopen the workspace to
   change profiles.
3. **Never fall back after an uncertain write.** A timeout, lost response, or
   aborted caller can leave a durable write. Re-read and reconcile; do not send
   the same mutation through the legacy backend.
4. **No production dual-write.** Tests may compare implementations against
   isolated fixtures. Production code must not mirror mutations to old and new
   paths.
5. **No production shadow-read that mutates legacy state.** The legacy cloud
   backend updates hidden revision state on reads. Compare implementations only
   with isolated backend instances.
6. **Preserve source identity.** A runtime cutover must not create new document
   IDs, share identities, or selected-path namespaces for the same workspace.
7. **Open is authoritative.** Opening or resuming a document always performs a
   new source read before accepting the source baseline.
8. **Every commit states intent.** Unconditional, if-absent, and if-unchanged
   are explicit values. An omitted revision never means "use whatever was read
   most recently."
9. **Capabilities are honest.** BrowserLocal observed checks remain labeled
   observed. They are never reported as atomic CAS, and a verified local commit
   does not claim that no external write occurred in its TOCTOU window.
10. **Hints are not content.** Observer and polling results only trigger an
    authoritative refresh barrier on the document path lane.
11. **Monitor only the active document.** Inactive documents refresh when
    opened.
12. **Freeze the compatibility facade.** After Stack A starts, do not add new
    behavior to `WorkspaceBackend`; implement new behavior in the final
    services.
13. **One lane per path.** Persistence ordering is keyed by workspace identity
    and normalized path. Session ID and epoch fence stale work but never create
    parallel lanes for one path.
14. **Do not write through uncertainty.** Missing, unavailable,
    recovery-required, partial, and unknown states stop automatic mutation
    until the named paths are reconciled.
15. **Never replace dirty Loro on a bad checkpoint.** A clean document may be
    reset through a Loro transaction; a dirty document enters explicit
    recovery.

## Transitional Runtime Model (Landing Only)

This model describes intermediate stacked-PR states. It is intentionally absent
from the final implementation, which constructs only the OpenDAL runtime ports.

Use a finite set of application-level rollout profiles during migration:

```ts
type WorkspaceRuntimeProfile = "legacy" | "documents" | "documents-and-entries" | "opendal";

type WorkspaceRuntimeRollout = Readonly<Record<WorkspaceStorageKind, WorkspaceRuntimeProfile>>;
```

The profile expands to one fixed port-selection table:

| Profile                 | Documents | Tree   | Entries | Assets |
| ----------------------- | --------- | ------ | ------- | ------ |
| `legacy`                | legacy    | legacy | legacy  | legacy |
| `documents`             | final     | legacy | legacy  | legacy |
| `documents-and-entries` | final     | final  | final   | legacy |
| `opendal`               | final     | final  | final   | final  |

Runtime assembly consumes this table and returns only `WorkspaceRuntime`.
Legacy adapters are the only modules allowed to hold `WorkspaceBackend`; final
services are the only modules allowed to hold `WorkspaceObjectStore`.

A provider receives exactly one profile while constructing its workspace
runtime. Production defaults live in one module-level rollout map; tests inject
an explicit map. An emergency rollback changes that map, rebuilds the app, and
requires the user to close and reopen the workspace. There is no live-session
switch and no user-facing setting.

Only the four named profiles are supported. Do not add independent booleans for
individual services; arbitrary combinations would create an untestable state
space. The final legacy-removal pull request deletes the profiles, rollout map,
and compatibility facade.

During a transitional profile, entry operations must flush and close the active
document before move or delete, as they do today. An entry operation cannot
race the document persistence coordinator for the same path.

The rollout map cannot enforce this alone. A static boundary test must reject
imports of `WorkspaceBackend` or `WorkspaceObjectStore` from React hooks and
components. Assembly tests must assert that each profile constructs exactly the
port selection in the table.

Expected rollout progression:

| Checkpoint           | BrowserLocal          | Dropbox            | Google Drive     | OneDrive         |
| -------------------- | --------------------- | ------------------ | ---------------- | ---------------- |
| Stack A and B0       | legacy                | legacy             | legacy           | legacy           |
| B1/B2 targeted proof | documents in tests    | documents in tests | legacy           | legacy           |
| B3 merged            | documents             | documents          | legacy           | legacy           |
| C0 merged            | documents-and-entries | documents          | legacy           | legacy           |
| Stack C merged       | opendal               | documents          | legacy           | legacy           |
| D0 merged            | opendal               | opendal            | opendal          | opendal          |
| D1 merged            | profiles removed      | profiles removed   | profiles removed | profiles removed |

## Persisted Document Migration

Current browser collaboration records already persist the last materialized
source value, content hash, Loro frontiers, and version vector. Extend this
metadata additively with a serialized source revision.

```ts
type SerializedSourceRevision =
  | { kind: "etag" | "version"; validation: "atomic"; value: string }
  | { kind: "fingerprint"; validation: "observed"; value: string };
```

Migration rules:

- Existing records without a revision remain valid.
- Keep the existing `materializedHash` algorithm and meaning for Loro checkpoint
  validation. Do not reinterpret it as the SHA-256 storage content hash.
- `SourceSnapshot.contentHash` is recomputed from authoritative bytes on open;
  this migration does not add a second persisted content-hash field.
- Opening an old record performs an authoritative source read and records the
  returned revision.
- Do not bump the IndexedDB schema solely for an optional record field.
- Older application code must continue to ignore the additive field safely
  during the migration window.
- Never persist provider tokens, operator objects, or browser handles in the
  collaboration database.
- A persisted revision is only a starting comparison point. Opening still
  reads the source and reconciles its current content.

## Pull Request Size Guardrails

Before submitting a layer, split it when any of these conditions are true:

- More than roughly 600 changed production lines, excluding generated output
  and tests.
- More than 15 production modules with semantic changes.
- More than one provider cutover plus a document semantic change.
- More than one persisted-data schema change.
- The pull request description needs more than one rollback procedure.
- A reviewer cannot demonstrate the layer without depending on an unmerged
  layer above it.

Expected contingency splits:

- Split B0 into port contracts/legacy adapters and hook rewiring if the static
  single-route change exceeds the limit.
- Split recovery-state UI from reconciliation logic if PR B2 exceeds the limit.
- Split BrowserLocal and Dropbox document cutover if PR B3 exceeds the limit.
- Split local tree reads from entry mutations if PR C0 exceeds the limit.
- Split Google Drive and OneDrive from the final provider pull request if their
  error mappings differ materially.

## Stack A: Storage Substrate

Merge all four layers before starting Stack B.

```text
trunk
  <- A0 migration baseline
  <- A1 BrowserLocal service
  <- A2 operator contract
  <- A3 workspace object store
```

### PR A0: Freeze migration behavior

- Branch: `opendal/migration-baseline`
- Risk: low
- Depends on: none

Implementation:

- Land the architecture record and this implementation plan.
- Add shared local-handle and cloud-operator test fixtures without changing
  production behavior.
- Add characterization tests for workspace identity, Markdown visibility,
  create/rename/delete, image allocation, external-edit reconciliation, and
  current cloud conditional writes.
- Record the current generated WebAssembly and production bundle sizes in the
  pull request, not as a permanent hard-coded test.

Proof:

- Existing application tests remain green.
- New characterization tests fail when a named baseline behavior is removed.
- UI smoke continues to exercise local, sharing, conflict, and Dropbox flows.

Rollback:

- Revert this documentation and test-only layer. It has no runtime state.

After this: reviewers have an executable regression baseline and a candidate
contract. A2/A3 remain unfrozen until the real BrowserLocal proof in A1 passes.

### PR A1: Add the BrowserLocal OpenDAL service

- Branch: `opendal/browser-local-service`
- Risk: high
- Depends on: A0
- Human checkpoint: required

Implementation:

- Implement project-owned `BrowserLocalAccess` for the pinned OpenDAL raw API.
- Accept a `FileSystemDirectoryHandle` supplied by JavaScript instead of
  acquiring OPFS internally.
- Resolve and validate relative paths below the injected root.
- Implement stat, list, read, write, create directory, delete, and the strongest
  honest rename behavior.
- Report conditional-write capabilities as unsupported.
- Map browser permission, missing-entry, type-mismatch, and unsupported errors
  to OpenDAL error kinds.
- Add a narrow internal WebAssembly construction path used by the browser
  smoke. Do not change application runtime selection yet.

Proof:

- Rust checks pass for `wasm32-unknown-unknown`.
- An automated browser smoke injects an OPFS directory handle into the actual
  WebAssembly build and performs create/list/stat/read/write/delete round trips,
  including a recursive directory removal.
- A Chromium manual smoke repeats the round trip with a directory returned by
  `showDirectoryPicker()`.
- Permission revocation and path traversal produce stable failures.
- The pull request reports WebAssembly size delta and initialization time.

Stop condition:

- Do not proceed if a real selected-directory handle cannot cross the
  `wasm-bindgen` boundary reliably, if writes cannot be verified after close, or
  if root confinement is not demonstrable.

Rollback:

- Remove the unused service and internal construction path. Every provider is
  still on the legacy profile.

After this: a real browser directory is readable and writable through an
OpenDAL Operator in WebAssembly, but no application behavior has changed.

### PR A2: Make the browser operator contract exact

- Branch: `opendal/operator-contract`
- Risk: high
- Depends on: A1
- Human checkpoint: required

Implementation:

- Introduce the final source union and `openOpendalBrowserOperator` factory.
- Require exact byte reads with a discriminated metadata binding:
  `same-read` with metadata or `none` without it.
- Delete the current independent read/stat fallback that returns the two values
  as though they described one source snapshot.
- Replace independent optional write flags with a discriminated write
  condition.
- Require successful writes to return an applied receipt with metadata binding
  `write-response`, `post-write`, or `none`.
- Introduce stable operator error codes for not found, already exists,
  condition failure, permission, authentication, rate limiting, unsupported,
  temporary failure, and unknown outcomes.
- Make delete and rename return `applied`, `partial`, or `unknown` receipts with
  reconciliation paths; preserve copy-delete partial state.
- Expose single-delete support and recursive delete as native, emulated, or
  unsupported. An emulated partial delete reports its subtree root.
- Report file and directory rename capabilities independently; directory
  copy-delete preserves partial subtree outcomes.
- Validate every generated WebAssembly value at the TypeScript facade.
- Migrate BrowserLocal and Dropbox to the exact contract.
- Retain a narrow compatibility wrapper for unmigrated cloud providers only.

Proof:

- BrowserLocal and mocked Dropbox pass the same operator conformance suite.
- Dropbox download proves that bytes and revision metadata came from one HTTP
  response.
- A provider without response-bound metadata returns `none`; it does not attach
  a parallel stat result.
- Write receipt tests distinguish response metadata, post-write observation,
  and no metadata without relabeling them.
- Dropbox version and no-clobber writes map to atomic provider conditions.
- A response-lost failure is not converted into a normal retry.
- A copy-delete failure after target creation reports both paths for
  reconciliation.
- Existing optional real-token Dropbox validation remains available but is not
  required in ordinary CI.

Rollback:

- Keep the compatibility exports and revert consumers of the exact contract.
  No application consumer exists yet.

After this: BrowserLocal and Dropbox expose one exact object API with different
but honest capabilities.

### PR A3: Implement the explicit-revision WorkspaceObjectStore

- Branch: `opendal/workspace-object-store`
- Risk: high
- Depends on: A2
- Human checkpoint: required

Implementation:

- Add static and renewable `OpendalOperatorHost` implementations.
- Add the provider-neutral `WorkspaceObjectStore`, source snapshot, revision,
  observation, probe, capability, commit, path-mutation, and stable storage
  error types.
- Select version, ETag, or observed fingerprint according to real operator
  capabilities.
- Compute `sha256:<base64url>` over exact bytes with Web Crypto and build
  observed revisions from a versioned canonical encoding. Do not reuse the
  existing lightweight Markdown comparison hash.
- For reads without same-read metadata, implement a bounded stat/read/stat
  capture. Bind bytes only when a stable provider token surrounds the read;
  otherwise mark the accepted capture observed.
- Return `present`, `missing`, or `unavailable` from source read and probe.
- Preserve all available normalized list metadata, including size,
  last-modified time, ETag, and version, without promoting list entries to
  content-bound revisions.
- Implement atomic commit mapping for providers that support it.
- Implement observed pre-read, write, read-back, and verification for
  BrowserLocal.
- Return `committed` only after establishing the next explicit revision from a
  response-bound receipt or authoritative readback; otherwise return `unknown`.
- Implement conditional create-directory, delete, and move outcomes. Preserve
  `partial` and `unknown` with required reconciliation paths; partial results
  identify target-copy, source-remove, or recursive-delete phase.
- Where native rename is unavailable but object primitives suffice, implement
  typed file/directory copy-delete in the object store: copy and verify the
  target subtree before deleting the source, and never auto-rollback a partial
  outcome.
- Preserve `unknown` when a commit result cannot be established.
- Add injectable hashing, operator, and `WorkspacePathLock` boundaries.
- Use Web Locks to serialize normalized path intents across same-origin tabs,
  with a keyed in-page fallback. Expand paths to ancestor intents, deduplicate
  using the strongest mode, and acquire them in deterministic order.
- Give read/probe/list shared path and ancestor locks, file commits an exclusive
  leaf with shared ancestors, and directory move/delete exclusive subtree
  roots. Keep observed preflight through verification inside one acquisition.
- Keep lock acquisition at public-method boundaries. Mutation preflight and
  verification use private unlocked capture helpers to avoid reentrant lock
  acquisition.
- Do not wire React or Loro callers in this layer.

Proof:

- One object-store conformance suite runs against BrowserLocal and Dropbox
  fixtures.
- Reading R1, externally producing R2, and committing against R1 produces
  `conflict` for Dropbox and an observed conflict for BrowserLocal when detected
  before its non-atomic write.
- A BrowserLocal race injected after the final pre-read demonstrates that the
  contract does not promise atomic no-clobber; the test asserts only post-write
  observation and honest capability labeling.
- Successful commits return a new explicit revision.
- Missing revision input cannot silently become an overwrite.
- Missing and unavailable probes are distinguishable, and a probe without a
  provider revision returns no fabricated token.
- List conformance proves that provider metadata is preserved while no list
  entry is accepted as a document source baseline.
- Same-read, stable-token sandwich, weak observed sandwich, changed-sample retry,
  and exhausted-sample unavailable cases are covered.
- Hash and fingerprint vectors cover empty bytes, Unicode UTF-8 bytes, binary
  data, metadata normalization, and persistence round trips.
- Partial move and lost-response tests force reconciliation of source and
  target paths.
- Native and emulated recursive delete pass the same outcome contract; an
  injected mid-tree failure reports partial rather than success.
- File and directory move conformance follows their separate capabilities.
- Copy-delete tests cover failure during target copy, failure during source
  removal, verified success, and both-root reconciliation without blind
  rollback.
- BrowserLocal directory move remains labeled observed and documents that a
  third-party source change during recursive copy cannot be excluded.
- Unconditional delete is idempotent, while conditional delete and move report
  missing-source conflicts and `if-absent` reports target-exists.
- Two object-store instances for the same workspace serialize a local observed
  commit; the second detects the first before writing. Overlapping multi-path
  intents acquire deterministically without deadlock.
- A parent-directory move/delete waits for a child read or commit, and a new
  child operation waits for the parent mutation.
- A browser test with two same-origin pages proves the Web Locks path, while a
  unit test proves the single-page fallback.
- A mutation can pre-read and verify under one exclusive lock without nested
  acquisition, while an external shared read waits for completion.
- Authentication retry tests distinguish reads, safe pre-application writes,
  and partial or unknown mutation outcomes.

Rollback:

- Remove the unused store and host modules. Every provider remains on the
  legacy profile.

Stack A merge gate:

- The exact operator and object-store contracts are reviewed and frozen.
- BrowserLocal passes a real selected-directory manual smoke.
- BrowserLocal limitations are documented as observed, not atomic.
- Source absence and path-mutation partial outcomes have explicit contracts.
- No production app flow has changed.

## Stack B: Document Persistence

Start this stack from trunk only after Stack A merges.

```text
trunk
  <- B0 runtime product ports
  <- B1 document source observations
  <- B2 document reconciliation states
  <- B3 document persistence coordinator
```

### PR B0: Introduce single-route runtime product ports

- Branch: `opendal/runtime-product-ports`
- Risk: high
- Depends on: Stack A

Implementation:

- Introduce `WorkspaceIdentity`, the four product port interfaces,
  `WorkspaceRuntime`, and temporary rollout profile types.
- Introduce `WorkspaceStorageKind` independently of `WorkspaceBackendKind`, but
  preserve the existing serialized provider-kind strings and alias matching.
- Implement legacy adapters for document, tree, entry, and asset behavior. Only
  those adapters may hold `WorkspaceBackend`.
- Construct a runtime once when opening or restoring a workspace.
- Move local and cloud runtime construction behind non-React assembly modules;
  provider hooks request a runtime instead of constructing a backend.
- Rewire hooks and components to accept only runtime product ports. They must
  not accept `WorkspaceBackend` or `WorkspaceObjectStore` in parallel.
- Change cache keys, BroadcastChannel names, share identity helpers, and
  selected-path persistence to consume `WorkspaceIdentity` rather than a
  backend used only for identity fields.
- Implement the fixed profile-to-port table while keeping every production
  provider on `legacy`.
- Keep provider and host-specific capabilities behind runtime construction.
- Preserve every existing workspace ID, source alias, document ID, and selected
  path key.
- Add a static boundary check that forbids legacy backend and object-store
  imports from React hooks and components.

Proof:

- All existing UI and collaboration tests pass without changed behavior.
- Runtime construction tests verify identity parity with the legacy factories.
- Assembly tests verify exactly one implementation per product port for every
  rollout profile.
- No object-store operation occurs while the runtime uses the legacy profile.
- Static search and the boundary check prove that no hook can select between
  raw legacy and final storage.
- Switching workspaces disposes the previous runtime exactly once.

Rollback:

- Revert the port adapters and hook wiring as one unit. No persisted data format
  has changed.

After this: every application caller has a stable, single-route product seam,
while all behavior still runs through legacy adapters.

### PR B1: Give document sessions explicit source observations

- Branch: `opendal/document-source-observations`
- Risk: high
- Depends on: B0
- Human checkpoint: required

Implementation:

- Add `WorkspaceDocumentService` over `WorkspaceObjectStore`.
- Open an active document from `SourceObservation<SourceSnapshot>`, not a bare
  string or a thrown not-found error.
- Model `present`, `missing`, and `unavailable` explicitly; keep the last
  present baseline when an open document becomes inaccessible.
- Store the active source revision and content hash in `DocumentSession` only
  from an authoritative present observation.
- Extend persisted Loro metadata additively with serialized source revision.
- Change external Markdown ingestion to consume an already-read source
  snapshot. It must not reach back into a backend and mutate hidden state.
- Commit a materialized document through the document service with its explicit
  session revision.
- On `conflict` or `unknown`, request an authoritative observation and remain
  blocked. Do not invoke the still-unsafe legacy fallback or retry in this pull
  request; B2 owns that state transition.
- Keep every production rollout on the legacy document port. Exercise the final
  port only through isolated service and browser tests until B3 completes.

Proof:

- Old collaboration records without source revision reopen and self-upgrade.
- Present, missing, and unavailable reads produce distinct document states.
- Missing or unavailable state never becomes an unconditional write.
- A remote R1/R2 conflict cannot be overwritten with a hidden R2 revision.
- An external edit between open and save triggers an authoritative observation.
- Source identity, sharing, BroadcastChannel, and relay tests remain stable.

Rollback:

- The production rollout profile remains legacy. Additive metadata fields are
  ignored by old readers.

After this: the final document port owns explicit storage observations, but
production still uses the legacy document adapter.

### PR B2: Make external-edit reconciliation stateful and loss-averse

- Branch: `opendal/document-reconciliation-states`
- Risk: high
- Depends on: B1
- Human checkpoint: required

Implementation:

- Split external-source ingestion into three proven paths: valid checkpoint
  fork/import, invalid checkpoint with clean Loro, and invalid checkpoint with
  dirty Loro.
- Keep valid-checkpoint import as a Loro update.
- Allow invalid-checkpoint replacement only when current Loro content still
  equals the last materialized source, and perform it as a Loro transaction.
- Enter `recovery-required` for an invalid checkpoint with dirty Loro. Preserve
  local and incoming text, publish no replacement, and schedule no write.
- Enter `missing` when the active source disappears. Retain Loro and offer Save
  As or an explicit user-confirmed recreate; never recreate automatically.
- Enter `unavailable` on permission, authentication, or transport uncertainty.
  Retain Loro and pause writes until an authoritative read succeeds.
- Treat an external move as missing at the original path. Do not infer path
  identity from a sibling appearance.
- On a present conflict, run the new reconciliation state machine and allow at
  most one bounded retry only after successful reconciliation.
- On an unknown commit, observe authoritatively. Mark saved only when current
  content and revision establish that outcome; otherwise remain blocked.
- Add explicit recovery commands: Keep Local As creates a verified
  `if-absent` target and opens it; Use External requires destructive
  confirmation and applies the incoming text as a Loro transaction.
- Re-read before Use External. If the incoming source changed since the dialog
  was shown, update the retained incoming snapshot and require confirmation
  again.
- Keep both values and the recovery state intact when either recovery mutation
  conflicts or has an unknown outcome.
- Route owner relay materialization and save acknowledgements through the same
  document service state machine.

Proof:

- A valid checkpoint merges dirty local and external changes.
- An invalid checkpoint replaces only a clean Loro document.
- An invalid checkpoint with dirty Loro preserves both values and enters
  recovery without emitting an autosave.
- External delete and permission loss preserve editor and collaboration state
  while blocking automatic projection.
- Reappearance at the same path is reconciled before writes resume.
- Explicit recreate and Save As both state `if-absent`; tests assert atomic or
  observed behavior according to provider capability.
- Keep Local As and Use External resolve recovery only after their respective
  storage or Loro transaction has succeeded.
- A second external edit while recovery is open updates the incoming snapshot
  without discarding local Loro state or accepting stale confirmation.

Rollback:

- Production remains on the legacy document port. Additive source metadata is
  ignored by old readers.

After this: final document semantics are safe enough to place behind a shared
persistence coordinator, but are not yet the production default.

### PR B3: Add the shared document persistence coordinator

- Branch: `opendal/document-persistence-coordinator`
- Risk: high
- Depends on: B2
- Human checkpoint: required

Implementation:

- Add one `DocumentPersistenceCoordinator` above `WorkspaceObjectStore`.
- Key every lane by workspace identity and normalized path only.
- Assign session ID and monotonic epoch as fencing state inside the lane. A new
  session waits for the prior session to close or receives a busy result.
- Keep one in-flight projection and one latest pending projection per session
  epoch. Coalesce only monotonic, complete Loro materializations from that epoch.
- Reject duplicate or decreasing generations before object-store I/O.
- Advance a retained projection only with the confirmed revision returned by an
  in-flight commit from the same epoch.
- Resolve superseded schedules only after the retained projection reaches a
  definitive outcome, and return the later durable generation. A projection
  discarded by refresh resolves blocked rather than durable.
- Add a source-refresh barrier to the same lane. A hint, conflict, or unknown
  result pauses pending projection, waits for the in-flight outcome, discards
  pre-refresh pending bytes, and invokes authoritative reconciliation.
- Sequence refresh requests monotonically. Coalesce requests waiting on one
  barrier, but run a follow-up refresh when a hint arrives during reconciliation.
- Ignore late results from stale epochs; they cannot mutate the new session's
  revision or save state.
- Implement flush and close semantics used by workspace switch, move, delete,
  share lifecycle, visibility changes, and page shutdown. Return a blocked
  result when durability remains unresolved.
- Do not coalesce different sessions, raw assets, create-if-absent, move, or
  delete.
- Route BrowserLocal and Dropbox active-document autosave through the
  coordinator and make `documents` their default profile.

Proof:

- A first/second/third burst persists first and third.
- Duplicate and decreasing generations are rejected without storage I/O.
- Superseded callers do not report durability before third commits.
- A refresh-discarded pending caller resolves blocked and can be rematerialized;
  it never hangs or reports the later bytes as its own durability.
- Different sessions for one path serialize on one lane and never coalesce.
- A stale epoch cannot advance a replacement session.
- A busy lane and blocked close have explicit results.
- A source hint arriving during an in-flight commit runs one refresh before any
  pending projection.
- A hint arriving during refresh produces one non-overlapping follow-up and is
  not lost.
- A conflict or unknown result installs one refresh barrier and stops blind
  draining.
- Local and Dropbox use the same coordinator tests.

Rollback:

- Select the legacy profile at workspace construction before opening a session.
  Never switch an already-open session after a write starts.

Stack B merge gate:

- Active local and Dropbox documents own explicit revisions.
- The new coordinator is the only active-document writer in the `documents`
  profile.
- Hooks and components see only runtime document ports, never raw legacy and
  final storage together.
- Missing, unavailable, and dirty-checkpoint recovery states block autosave.
- External conflict, owner relay, BroadcastChannel, workspace switch, and page
  lifecycle tests pass.
- No tree, entry, or asset caller depends directly on the new object store yet.

## Stack C: Local Product Cutover and Change Detection

Start this stack only after Stack B runs successfully as the default document
path.

```text
trunk
  <- C0 local tree and entry services
  <- C1 local asset service
  <- C2 active-file observer
  <- C3 current-file polling fallback
```

### PR C0: Move local tree and entry actions to WorkspaceObjectStore

- Branch: `opendal/local-tree-entry-services`
- Risk: medium
- Depends on: Stack B

Implementation:

- Implement Markdown tree construction and lazy directory reads in
  `WorkspaceTreeService`.
- Implement create, move, delete, starter content, and naming rules in
  `WorkspaceEntryService`.
- Keep internal paths and ignored directories out of the Markdown tree without
  placing those rules in OpenDAL.
- Consume normalized entry kinds and paths while leaving source-baseline
  decisions to document probe/read operations.
- Route local tree, refresh, create, move, and delete UI operations through
  the services.
- Require active-document flush and close before mutating its exact path or any
  ancestor directory. For an applied directory move, derive and verify the
  active document's destination path before reopening it.
- Use explicit object-store capabilities and conditional mutation requests.
  New targets use `if-absent`; an existing file uses its explicit revision when
  obtainable. A provider or directory without conditional source validation
  requires explicit unconditional intent and the existing destructive-action
  confirmation.
- Reject recursive delete before I/O when unsupported, and preserve partial
  recursive outcomes for authoritative subtree refresh.
- Select file or directory move capability from the typed entry request; never
  infer directory semantics from a trailing slash.
- Reconcile every listed path before recovering from `partial` or `unknown`.
- For partial target copy, retain the source and offer explicit target cleanup.
  For partial source removal, verify the target before offering removal of the
  remaining source. Unknown state permits no destructive action until both
  roots are re-listed.
- After an applied app-initiated move, verify old and new paths before opening a
  new document persistence session at the destination.
- Advance BrowserLocal to the `documents-and-entries` rollout profile.

Proof:

- Existing local tree and entry tests pass against the object-store-backed
  services.
- The UI smoke performs local create, edit, rename, refresh, and delete through
  BrowserLocal OpenDAL.
- A move cannot race an active document persistence lane.
- Moving or deleting a parent directory closes the active descendant session
  and respects hierarchical path locks.
- Target-exists, source-changed, partial copy-delete, and unknown outcomes do
  not become success or blind retry.
- Internal state remains hidden and preserved.

Rollback:

- Reopen the workspace with the legacy profile. No data format changes are
  introduced.

After this: local Markdown documents and entry operations use OpenDAL; asset
operations still use the legacy adapter.

### PR C1: Move local assets to WorkspaceObjectStore

- Branch: `opendal/local-asset-service`
- Risk: medium
- Depends on: C0

Implementation:

- Implement image validation, name allocation, byte commit, and Markdown
  reference generation in `WorkspaceAssetService`.
- Route local image operations through the object store.
- Retain browser file-handle path lookup as a local host capability.
- Retain directory selection, permission requests, handle persistence, Save As,
  and later observation as browser host responsibilities.
- Remove direct local content I/O from the compatibility backend.
- Make the full `opendal` profile the default for BrowserLocal.

Proof:

- Image allocation uses atomic no-clobber where supported and honestly observed
  `if-absent` checks on BrowserLocal, while generating the same Markdown paths.
- A detected target collision chooses another name without overwriting.
- Dragged local file handles still resolve to workspace paths.
- The local UI smoke passes with direct local backend construction disabled.

Rollback:

- The temporary legacy profile remains selectable until Stack D, but it cannot
  be selected after an uncertain object-store write in the same session.

After this: all content I/O inside the selected local directory uses OpenDAL.
File System Access is only the host boundary for selection, permission, handle
identity, and hints. Browser collaboration persistence remains independent.

### PR C2: Observe only the active local document

- Branch: `opendal/active-file-observer`
- Risk: high
- Depends on: C1
- Human checkpoint: required

Implementation:

- Implement a BrowserLocal `CurrentDocumentChangeSource` beside the object
  store.
- Resolve the active document's immediate parent directory handle.
- Observe that parent without recursion and filter records to the active file.
- Treat appeared, disappeared, modified, and relevant move records as hints.
- Coalesce bursts into one source-refresh barrier on the active document lane.
- Treat unknown records and lifecycle recovery as `resync-required` while
  keeping the observer active.
- Treat unsupported construction and terminal observer errors as
  `monitor-unavailable`: request one refresh, dispose the observer, and activate
  polling. Let the authoritative observation determine source permission state.
- Abort the previous subscription when switching documents or workspaces.
- Isolate hint-listener failures so one consumer exception cannot tear down the
  native observer lifecycle.
- Refresh authoritatively on open, `pageshow`, and return to visible state.
- Feed the resulting source observation into the document reconciliation state
  machine. A disappearance enters `missing`; an access failure enters
  `unavailable`.
- Deduplicate self-write observer records using the committed revision and
  content hash, not a time window.

Proof:

- Clean external edits appear in the active Loro document.
- Dirty Loro edits survive a simultaneous external source edit.
- Editor save patterns that replace a file through a sibling are detected by
  the parent observation.
- Switching documents prevents late hints from changing the new document.
- No inactive document and no recursive workspace path is observed.
- Resync-required and monitor-unavailable take distinct lifecycle paths.
- A throwing hint listener is contained and cleanup still runs.
- A Chromium manual smoke edits the selected file from outside the app.

Rollback:

- Disable the optional change source. Open and resume reconciliation still
  protect the active document.

After this: supported Chromium browsers receive low-latency current-document
hints without adding workspace-wide watch behavior.

### PR C3: Add current-document polling fallback

- Branch: `opendal/current-file-polling`
- Risk: medium
- Depends on: C2

Implementation:

- Add one non-overlapping poller for the active document when native hints are
  unavailable or the provider has no native source.
- Poll BrowserLocal fallback only while visible, initially around three
  seconds.
- Poll cloud sources only while visible, initially around ten seconds.
- Call `WorkspaceObjectStore.probe` and use an atomic revision to avoid content
  reads when the probe supplies one.
- For observed sources without a reliable metadata revision, read and hash the
  current document.
- Apply jitter and exponential failure backoff up to one minute.
- Pause while hidden and refresh immediately on visibility, page-show, and
  online recovery.
- Stop scheduling new work on abort and ignore late results from a previous
  document. Do not claim to cancel an already-awaited object-store Promise.
- Send every detected change through the same lane refresh barrier and Loro path
  used by the observer.

Proof:

- A browser with `FileSystemObserver` disabled imports a local external edit.
- A mocked remote revision change imports a Dropbox external edit.
- A probe without a usable revision performs read-and-hash; a stable atomic
  probe avoids the content read.
- Poll operations never overlap.
- Hidden pages stop periodic work and resume with an immediate refresh.
- Backoff, jitter, missing files, transient failures, abort, and late results
  are deterministic under injected scheduling tests.
- Missing and unavailable observations reach their distinct document states.
- Self-writes do not create a reconciliation loop.

Rollback:

- Disable polling while retaining open, resume, and observer reconciliation.

Stack C merge gate:

- All BrowserLocal content I/O uses OpenDAL.
- Only the active document owns an observer or poller.
- Local external edits reach Loro in supported and fallback browsers.
- Local entry, asset, collaboration, and sharing UI smoke flows pass.
- Direct File System Access remains only for host capabilities.

## Stack D: Provider Completion and Legacy Removal

Start this stack only after BrowserLocal and Dropbox have run through the final
runtime in production-like smoke tests.

```text
trunk
  <- D0 remaining provider cutover
  <- D1 compatibility removal
```

### PR D0: Move remaining providers to the final runtime

- Branch: `opendal/remaining-provider-cutover`
- Risk: medium
- Depends on: Stack C

Implementation:

- Migrate Google Drive and OneDrive to the exact operator and object-store
  contracts.
- Keep S3 support aligned in the browser package even when no app UI exposes it.
- Map each provider's strongest usable read/probe revision, conditional
  mutation capability, and partial/unknown outcome honestly.
- Return `metadataBinding: "none"` when a provider adapter cannot bind metadata
  to the content response; let the object store stabilize that read.
- Route cloud tree, entry, asset, and document services through the final
  runtime.
- Advance Dropbox, Google Drive, and OneDrive to the `opendal` profile.
- Preserve OAuth redirects, roots, drive identity, and token refresh behavior.
- Split provider-specific pull requests if error or revision mappings exceed
  the size guardrails.

Proof:

- Every provider passes the applicable operator and object-store conformance
  suite.
- Google Drive observed revisions remain labeled observed when atomic
  conditions are unavailable.
- Where OneDrive or Dropbox reports atomic conditional-write capability, the
  condition maps to a provider receipt.
- Provider move/delete tests preserve partial or unknown outcomes and reconcile
  every affected path.
- Existing provider startup and redirect tests pass.
- Optional credentialed smokes remain separate from ordinary CI.

Rollback:

- Provider construction can select the temporary legacy profile before opening
  a workspace. Do not fall back after an uncertain mutation.

After this: every existing provider constructs the same final runtime and uses
the same product services.

### PR D1: Remove the compatibility backend

- Branch: `opendal/remove-legacy-workspace-backend`
- Risk: medium
- Depends on: D0

Implementation:

- Remove the legacy port adapters and backend-based runtime factories after
  proving every hook and collaboration helper already uses final runtime ports.
- Remove the broad optional-method backend type.
- Remove direct local backend construction.
- Remove the cloud `knownRevisions` map and backend-level write queue.
- Remove compatibility operator exports and provider adapters.
- Remove temporary rollout profiles, the rollout map, and rollback flags.
- Move remaining Markdown tree types and helpers into their owning product
  modules.
- Update package and application documentation to the final public and internal
  surfaces.

Proof:

- Static search finds no legacy backend construction, hidden revision map, or
  backend-level document queue.
- All application tests, package tests, builds, audits, bundle checks, and UI
  smokes pass.
- A clean checkout rebuilds the WebAssembly package and production app.
- Local and Dropbox manual scenarios cover external edits and conflict outcomes.

Rollback:

- Revert the pull request as a unit. Do not partially restore individual legacy
  methods after the compatibility layer has been deleted.

Stack D merge gate:

- All providers use Operator -> Host -> ObjectStore -> product/document
  services.
- No caller derives write baselines from shared mutable backend state.
- No caller discovers storage capability through optional method presence.
- The application has one document persistence and reconciliation path.

## Required Scenario Matrix

The following scenarios must be assigned to automated tests or an explicit
manual smoke before final cutover.

| Scenario                           | BrowserLocal               | Dropbox                 | Other cloud            |
| ---------------------------------- | -------------------------- | ----------------------- | ---------------------- |
| Open present source                | automated + browser        | mocked + optional real  | mocked                 |
| Probe with provider revision       | capability-specific        | atomic token            | capability-specific    |
| Probe without provider revision    | read and hash              | read and hash if absent | read and hash          |
| Create if absent                   | observed, race documented  | atomic                  | capability-specific    |
| Save unchanged baseline            | observed, race documented  | atomic                  | capability-specific    |
| External edit before save          | Loro integration           | Loro integration        | contract               |
| Dirty edit with valid checkpoint   | fork/import                | fork/import             | fork/import            |
| Clean edit with invalid checkpoint | Loro replacement txn       | Loro replacement txn    | contract               |
| Dirty edit with invalid checkpoint | recovery required          | recovery required       | recovery required      |
| External edit after final pre-read | observed TOCTOU limit      | atomic conflict         | capability-specific    |
| Response lost after write          | reconcile unknown          | reconcile unknown       | contract               |
| Rapid projection burst             | shared coordinator         | shared coordinator      | shared coordinator     |
| Same-runtime sessions for one path | one fenced lane            | one fenced lane         | one fenced lane        |
| Same-origin tab writers            | Web Locks or observed risk | Web Locks plus CAS      | capability-specific    |
| Hint during in-flight projection   | refresh barrier            | refresh barrier         | refresh barrier        |
| Move active document               | flush, close, verify       | flush, close, verify    | contract               |
| Partial or unknown move            | reconcile both paths       | reconcile both paths    | contract               |
| Missing active file                | writes paused              | writes paused           | writes paused          |
| External move                      | original path missing      | original path missing   | original missing       |
| Permission/token expiry            | unavailable state          | refresh or unavailable  | refresh or unavailable |
| Page hidden and resumed            | immediate refresh          | immediate refresh       | immediate refresh      |
| Document switch with late result   | stale epoch ignored        | stale epoch ignored     | stale epoch ignored    |
| Owner relay update                 | integration                | integration             | integration            |

## Validation Commands

Every pull request runs:

```bash
vp check
vp run -r test
```

OpenDAL package layers additionally run:

```bash
vp run @codemirror-treesitter/opendal-wasm-browser#check:wasm
vp run @codemirror-treesitter/opendal-wasm-browser#test
vp run @codemirror-treesitter/opendal-wasm-browser#build
```

Application cutover layers additionally run:

```bash
vp run local-md-workspace#i18n:check
vp run local-md-workspace#test
vp run local-md-workspace#build
vp run local-md-workspace#smoke:ui
```

Before merging the top of each stack, run:

```bash
vp run -r build
vp run audit
vp run ready
```

Credentialed provider validation is supplemental. Ordinary CI must remain
deterministic without long-lived cloud credentials.

## Stacked Pull Request Workflow

All stack branches must live in the same repository. Use GitHub's `gh-stack`
extension while the feature is in public preview.

Initial setup:

```bash
gh extension install github/gh-stack
```

For each stack:

```bash
gh stack init BRANCH-NAME
# implement, verify, commit the bottom layer
gh stack add NEXT-BRANCH-NAME
# repeat for remaining layers
gh stack submit
```

When a lower layer changes after review:

```bash
gh stack checkout BRANCH-NAME
# implement, verify, commit the correction
gh stack rebase --upstack
gh stack push
```

Review and merge from the bottom upward. Do not start the next stack until the
previous stack's top layer has merged and the checkpoint proof has run on trunk.
If the preview extension changes, preserve the same branch dependency graph by
setting each pull request base manually.

Each pull request description must include:

- Stack position and base branch.
- Final contract introduced by this layer.
- Transitional behavior intentionally left in place.
- Data or concurrency invariants affected.
- Automated and manual proof performed.
- Rollback procedure.
- Explicit non-goals.

## Review Checkpoints

Human review is required before building above these layers:

1. **A1 BrowserLocal boundary:** verify a real selected directory, permissions,
   root confinement, and WebAssembly cost.
2. **A2/A3 storage contracts:** approve exact read, source observations,
   revisions, conditions, capabilities, partial path mutations, and unknown
   semantics.
3. **B0 runtime ports:** verify hooks cannot receive legacy and final storage
   paths together.
4. **B1/B2 document semantics:** approve persisted revision migration, missing
   and unavailable behavior, and dirty-checkpoint recovery.
5. **B3 persistence ordering:** approve path-only lane keys, session epoch
   fencing, coalescing, and refresh barriers.
6. **C2 external editing:** manually exercise a native editor that modifies,
   deletes, and replaces the active file.
7. **D1 removal:** confirm no product caller still needs the compatibility
   facade before deletion.

## Final Definition of Done

The migration is complete when all of the following are true:

- BrowserLocal and every existing cloud provider construct an exact browser
  OpenDAL operator.
- Every application source read returns `present`, `missing`, or `unavailable`;
  a present read contains bytes, metadata, capture strength, and an explicit
  revision without fabricating a same-read binding.
- Polling uses the explicit probe contract and reads content when no reliable
  provider revision is available.
- Every commit states unconditional, if-absent, or if-unchanged intent.
- Object-store mutations serialize their normalized path set within a page and
  across same-origin tabs when Web Locks are available; no queue merges
  different callers.
- Delete and move state source/target intent and return applied, conflict,
  partial, or unknown outcomes.
- Document sessions own source revisions and corresponding Loro baselines.
- Local and cloud autosave use one document persistence coordinator keyed by
  workspace and normalized path.
- Session epochs fence late work, and source refreshes share the persistence
  lane with projection writes.
- BrowserLocal content I/O no longer bypasses OpenDAL.
- Only the active document is observed or polled.
- External changes enter Loro through authoritative source observations.
- Invalid checkpoints never replace dirty Loro; missing, unavailable, and
  recovery-required sources pause automatic writes.
- Atomic providers enforce no-clobber. BrowserLocal remains honestly observed,
  and its unavoidable TOCTOU limitation is documented and tested.
- Detected conflicts, partial mutations, and unknown outcomes are never treated
  as success or blindly retried.
- React hooks use one assembled implementation per product port.
- Workspace identities and existing collaboration records remain stable.
- The compatibility backend, hidden revision map, backend write queue, and
  temporary rollout profiles are removed.
- Full repository validation and required browser smokes pass from a clean
  checkout.
