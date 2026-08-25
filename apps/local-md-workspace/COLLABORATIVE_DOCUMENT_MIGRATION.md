# Collaborative Document Migration

## Audience and outcome

This plan is for engineers changing Grove workspace document infrastructure.
After reading it, an engineer should be able to implement or review one layer
of the migration without reintroducing active-editor ownership, parallel write
paths, or session-scoped persistence.

## Goal

The workspace collaborative document is the only authority for current logical
Markdown content:

```text
Human ---------+
Agent ---------+
Remote --------+--> CollaborativeDocument (Loro)
File import ---+             |
                             +-- UI subscribers
                             +-- collaboration transports
                             +-- browser recovery storage
                             +-- filesystem materializer
```

CodeMirror is a view over a document. The filesystem is a durable projection
and an external-change input. Browser collaboration storage is crash recovery.
None of them is an alternative current-content authority.

## Invariants

1. Within one workspace lifetime, a normalized path resolves to one
   `CollaborativeDocument` instance.
2. Opening the same path concurrently returns the same in-flight promise.
3. A document remains alive when the selected UI path changes. Documents close
   only when the workspace closes.
4. Human, Agent, remote, and external-file changes enter the same Loro document.
5. Only the document materializer writes current document content to the
   filesystem source.
6. A save already in progress never rejects another collaborative edit. A newer
   edit schedules another projection of the latest state.
7. Browser recovery is attempted independently of filesystem projection. A
   blocked filesystem projection does not make an accepted edit disappear.
8. UI selection state can become stale without making the document stale.

The document registry belongs to a single workspace runtime, so its key is only
the normalized path:

```ts
Map<NormalizedPath, Promise<CollaborativeDocument>>;
```

A rejected open is removed from the map because no document instance was
created. A successful open is never replaced during that workspace lifetime.

## Core contract

```ts
interface WorkspaceDocuments {
  document(path: string): Promise<CollaborativeDocument>;
  close(): Promise<void>;
}

interface CollaborativeDocument {
  read(): string;
  edit(edits: readonly ExactTextEdit[]): EditResult;
  subscribe(listener: DocumentListener): () => void;
  flush(): Promise<void>;
}

interface ExactTextEdit {
  from: number;
  to: number;
  expectedText: string;
  insert: string;
}
```

`expectedText` is a local compare-and-set precondition, not a document version
token. It prevents a semantic edit calculated from an old read from modifying
the wrong current range. Edits may fail because their ranges or expected text
do not match. They must not fail because another actor or save operation owns
the document.

Implementations may expose internal adapters for Loro editor binding, remote
updates, external-source reconciliation, and recovery. Those adapters must not
expose a general filesystem content-write bypass to UI or Agent code.

## Edit and flush semantics

An edit is synchronous and atomic relative to the document's JavaScript call
stack:

1. Validate every range and `expectedText` against one current snapshot.
2. Reject the whole edit set if any range is invalid, stale, or overlapping.
3. Apply all edits to Loro in one transaction.
4. Notify subscribers and schedule both recovery persistence and source
   materialization.

`flush()` is a durability barrier. It waits until every edit accepted before
the call is durable in browser recovery storage and has reached a terminal
filesystem projection state. Edits accepted during the flush belong to a later
generation and cannot prevent the barrier from completing. Workspace close
first stops new edits, then flushes through the final generation.

Filesystem conflicts, unavailable providers, missing sources, and recovery
requirements are document state. They do not roll back Loro. Callers must be
able to distinguish "edit applied, projection blocked" from "edit not
applied" so retries cannot duplicate content.

## Materializer

Each document owns one coalescing materializer with:

```text
requested generation
browser-durable generation
source-terminal generation
one running projection promise
one trailing debounce timer
```

When a projection completes, the materializer compares the completed
generation with the latest requested generation. If newer work exists, it
projects the latest document state next. It never reserves a path for a UI
session and never returns `busy`.

External observations and source commits use the same document-owned source
queue. A conditional commit conflict causes a new observation, import or merge
into Loro, and retry. An unsafe merge enters explicit recovery state while Loro
and browser recovery remain writable.

## Ownership boundaries

The workspace runtime owns the document registry and the low-level source
port. Content consumers receive the registry, not the source port.

Each collaborative document owns:

- its `LoroDoc` and `UndoManager`;
- browser snapshot and pending-update persistence;
- its coalescing filesystem materializer;
- external-source reconciliation state;
- cross-tab synchronization;
- any relay transport attached to that document;
- document subscribers and their current persistence snapshot.

The UI view coordinator owns only the latest selection intent, loading
projection, selected path, and current view subscription cleanup. It does not
flush, dispose, fence, lease, or otherwise own a document.

Rename and delete retain path identity. The old-path document remains the same
instance and observes a missing source. A renamed destination is a new path and
therefore a different document. If logical identity across rename is ever
required, the registry invariant must change to a stable file ID rather than
adding an exception to path identity.

## Agent contract

The Agent reads and edits any Markdown path through `WorkspaceDocuments`; the
path does not need to be selected in CodeMirror.

The content tools become:

```text
read_file(path)
write_file(path, edits)
```

`write_file` applies exact edits first and then reports browser and filesystem
durability separately. It has no active-editor dependency, document/session
generation, or opaque version token.

The existing `list_markdown_files` and `search_markdown` discovery tools remain.
This migration changes content authority, not workspace discovery capability.

## Stacked delivery

### 1. Collaborative document core

Introduce the contracts, normalized-path registry, document-owned browser
recovery, source queue, coalescing materializer, external reconciliation, and
workspace-wide close. Keep the implementation isolated until its concurrency
and lifecycle tests pass.

Acceptance criteria:

- concurrent opens share one promise and one Loro document;
- a failed open can be retried;
- edits during a source write are accepted and the latest value is eventually
  projected;
- `flush()` observes its generation barrier;
- source failure preserves Loro and browser durability;
- workspace close waits for every opening/open document and frees each native
  resource once.

### 2. UI and collaboration integration

Atomically replace workspace-document loading and saving with the registry.
CodeMirror, cross-tab synchronization, relay hosting, external changes,
recovery dialogs, and save-state UI subscribe to the same document. Single-file
drafts remain a separate non-workspace flow.

Acceptance criteria:

- selecting A, B, then A reuses A's document and undo history;
- switching selection performs no document flush or dispose;
- remote and external changes continue while a document is not selected;
- UI save state is a projection of document persistence state;
- replacing or closing a workspace flushes and closes the entire registry.

### 3. Agent path-based editing

Replace the active-editor adapter with registry reads and exact document edits.
Keep list and search tools. Preserve tool-call deduplication and abort checks,
but remove active-document versions and generation conflicts.

Acceptance criteria:

- the Agent edits an unopened or unselected Markdown file;
- opening that file later shows the same Loro state;
- concurrent human edits cause exact-edit conflict or a valid CRDT edit, never
  a session ownership error;
- an applied edit with blocked source projection is reported as applied.

### 4. Final cleanup

Delete the superseded session coordinator, persistence fence/lane, active-only
change source, active-editor Agent adapter, opaque version contracts, and all
compatibility branches. Rewrite tests around final public behavior and remove
tests that exist only for deleted intermediate abstractions.

Acceptance criteria:

- no active/inactive document persistence semantics remain;
- no document epoch, lease, fence, session ID, or Agent version token remains;
- no "another document is writing" path remains;
- documentation describes only the final architecture;
- format, lint, type checks, unit tests, build checks, audit, Agent smoke, and UI
  smoke all pass from the final stacked branch.

## Validation matrix

Every layer runs focused tests before its commit. The final stacked branch runs:

```sh
vp check
vp run local-md-workspace#test
vp run local-md-workspace#build
vp run local-md-workspace#bundle:check
vp run local-md-workspace#i18n:check
vp run local-md-workspace#smoke:agent
vp run local-md-workspace#smoke:ui
vp run audit
```

The final review also searches for every deleted concept and inspects the
production bundle so stale compatibility APIs cannot survive only because they
are untested.
