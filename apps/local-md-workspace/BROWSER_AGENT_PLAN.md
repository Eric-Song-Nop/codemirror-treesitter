# Browser Agent Implementation Plan

This document is the implementation contract for adding a browser-resident
Markdown Agent to Grove's Local MD Workspace. The Agent orchestration, tools,
state, and UI run in the web application. Model inference may use a remote API
with a user-provided API key.

The work is delivered as a GitHub stacked-PR series. Each PR must remain useful,
reviewable, and tested when checked out on top of its declared base branch.

## Product Decisions

- Use Vercel AI SDK Core as the first Agent runtime.
- Start with the OpenAI provider and a user-provided API key.
- Keep the API key in page memory only. Provider and model choices may be
  persisted, but the key, Authorization header, and provider response bodies
  must not enter browser storage or logs.
- Run the MVP Agent on the browser main thread. Remote streaming and workspace
  I/O are asynchronous; a Worker becomes relevant only for local inference or
  a CPU-heavy long-lived index.
- Allow workspace-wide Markdown listing, reading, and literal text search.
- Allow writes only to the workspace document that is active when the Agent run
  starts.
- Treat an Agent edit as another local editor input. Use the existing ordinary
  undo behavior; do not add an Agent peer, inverse updates, selective Agent undo,
  run rollback, or per-edit approval.
- Dispatch Agent changes through the active CodeMirror `EditorView`. The
  existing `loro-codemirror` binding then commits them as local operations on
  the main Loro peer and feeds the existing browser persistence, cross-tab,
  relay, and source-autosave paths.
- Reject stale intent before dispatch. CRDT convergence does not make a model's
  edit semantically correct when the user or another peer changed its base.
- Keep Agent domain contracts independent of any SDK so another browser Agent
  runtime can replace AI SDK later.

## MVP Scope

The MVP includes:

- an Agent panel in the workspace route;
- in-memory OpenAI API-key and model configuration;
- streamed assistant text and summarized tool activity;
- Stop and New chat actions;
- workspace context, Markdown listing, reading, and bounded search;
- reading the unsaved active document from CodeMirror/Loro memory;
- version-bound exact replacements in the current document;
- structured conflict, truncation, unavailable, and provider errors;
- normal Loro undo, browser persistence, BroadcastChannel, Grove Relay, and
  OpenDAL autosave behavior;
- English and Simplified Chinese UI;
- lazy loading so AI SDK and its provider do not enter the launcher bundle.

The MVP excludes:

- guest shared-file and standalone-file Agent entry points;
- writes to inactive files;
- create, rename, move, delete, or multi-file transactions;
- an Agent-specific undo stack or proposal/fork workflow;
- conversation persistence;
- arbitrary URL fetching, shell, eval, DOM automation, or dynamic tools;
- WebLLM, browser Prompt APIs, embeddings, or a persistent search index.

## Architecture

```text
WorkspaceAgentPanel
        |
        v
useWorkspaceAgent
- messages / streaming / cancellation / run budgets
        |
        v (dynamic import)
AI SDK adapter
- ToolLoopAgent / OpenAI provider / schemas
        |
        v
WorkspaceAgentHost
- provider-neutral tools and active-document capability
        |
        +-- WorkspaceRuntime tree/documents --> OpenDAL
        |
        `-- EditorView.dispatch
              --> loro-codemirror main-peer commit
              --> IndexedDB pending log
              --> BroadcastChannel / Grove Relay
              --> LiveMD input / autosave / OpenDAL materialization
```

The Agent UI and SDK adapter never receive a raw OpenDAL operator,
`FileSystemHandle`, OAuth token, or mutable `LoroDoc` handle.

## Tool Contract

The first tool set is:

```text
get_workspace_context
list_markdown_files
read_markdown
search_markdown
apply_current_document_edits
```

`read_markdown` returns the live CodeMirror value and an opaque version token
when its path is the active document. Inactive files are read from
`WorkspaceRuntime.documents.observe` and remain read-only.

The active-document version token represents at least:

```ts
type ActiveDocumentVersion = {
  version: 1;
  workspaceId: string;
  documentId: string;
  path: string;
  documentGeneration: number;
  editVersion: number;
  contentHash: string;
};
```

The write tool accepts exact replacements:

```ts
type AgentTextEdit = {
  oldText: string;
  newText: string;
};
```

Every `oldText` must identify exactly one range in the base snapshot. All edits
are resolved against that same snapshot, must not overlap, and are dispatched in
one CodeMirror transaction. Missing, ambiguous, overlapping, stale, or oversized
edits produce a structured result and no partial write.

Immediately before dispatch, in one synchronous call stack, the host validates
workspace identity, document ID, path, document generation, edit version,
content hash, editor/Loro agreement, and cancellation state. A conflict lets the
Agent reread and retry at most twice.

## Initial Budgets

These defaults are deliberately conservative and may be tuned from browser
measurements:

| Budget                       |       Initial value |
| ---------------------------- | ------------------: |
| Read window                  | 64 KiB or 400 lines |
| Search files                 |                 200 |
| Search input                 |               5 MiB |
| Per-file search              |             512 KiB |
| Search matches               |                 100 |
| Local/cloud read concurrency |               4 / 2 |
| Minimum literal query        |        2 characters |
| Replacements per write       |                  32 |
| Agent steps per run          |                  12 |
| Stale retries                |                   2 |

Search is literal substring matching in the MVP. It reports scanned files,
bytes, matches, partial failures, and the budget that truncated a result. The
active document's unsaved value overrides its storage observation.

## Stacked Pull Requests

### PR 1: Plan and workspace read/search foundation

- Branch: `feat/markdown-agent`
- Base: `main`
- Persist this plan.
- Add SDK-independent contracts, limits, catalog traversal, read, and search.
- Add active-document read override and run-scoped scan caching.
- Add active-document read override and bounded concurrent scanning.
- Add unit tests for recursion, filtering, ordering, budgets, partial failures,
  and cancellation.

### PR 2: Versioned current-document edit bridge

- Branch: `feat/markdown-agent-edit`
- Base: `feat/markdown-agent`
- Add compound active-document version tokens.
- Add exact-replacement resolution and validation.
- Dispatch one `input.agent` CodeMirror transaction.
- Verify immediate LiveMD updates, normal undo, local Loro updates, and stale
  rejection without adding a second persistence or relay path.

### PR 3: Browser AI SDK runtime

- Branch: `feat/markdown-agent-runtime`
- Base: `feat/markdown-agent-edit`
- Add `ai`, `@ai-sdk/openai`, and schema validation dependencies.
- Add the provider-neutral runtime facade, AI SDK adapter, tool schemas, OpenAI
  BYOK configuration, instructions, run budgets, cancellation, and tool-call
  deduplication.
- Add a scripted/fake model test for search, read, conflict, reread, edit, and
  final response.

### PR 4: Agent panel and BYOK flow

- Branch: `feat/markdown-agent-ui`
- Base: `feat/markdown-agent-runtime`
- Add the header entry point, responsive Agent panel, messages, tool activity,
  API-key/model settings, Send, Stop, and New chat.
- Bind a run to its starting workspace document and cancel it on panel close,
  document switch, or workspace replacement.
- Add English/Chinese strings, keyboard behavior, focus restoration, and live
  status announcements.

### PR 5: Integration, bundle, and release contract

- Branch: `test/markdown-agent-integration`
- Base: `feat/markdown-agent-ui`
- Add real-browser fake-model coverage.
- Cover IndexedDB reload, cross-tab BroadcastChannel, owner/guest Relay,
  autosave, cancellation, and stale races.
- Assert that AI SDK/provider code stays out of the initial bundle.
- Finish app/root documentation and agent-facing repository notes.

## Required Validation

Each PR runs its focused tests. The top of the stack must pass:

```bash
vp check
vp run local-md-workspace#i18n:check
vp run local-md-workspace#test
vp run local-md-workspace#build
vp run local-md-workspace#smoke:ui
vp run grove-relay#test
vp run @codemirror-treesitter/live-md-loro#test
vp run -r test
```

At least one manual or non-PR-blocking browser smoke uses a real user-provided
provider key without printing or persisting it.

## Definition of Done

- The Agent can list, read, and search browser-local and cloud workspaces.
- Unsaved active content takes precedence over the source file.
- Only the run's active workspace document can be modified.
- User, remote-peer, document, and workspace changes invalidate a stale write.
- An Agent edit appears immediately in LiveMD and uses normal undo.
- IndexedDB, BroadcastChannel, Relay, autosave, conflict recovery, and OpenDAL
  writes continue through their existing paths.
- Stop prevents any later tool execution; an already-dispatched edit remains.
- The API key is page-memory-only and absent from URLs, logs, and browser
  persistence.
- The AI SDK runtime remains a lazy chunk.
- Existing workspace, collaboration, PWA, and LiveMD behavior has no regression.
