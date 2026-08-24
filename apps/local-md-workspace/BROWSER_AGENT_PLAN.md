# Browser Agent Architecture and Contracts

This document records the lasting implementation contract for Grove's
browser-resident Markdown Agent. The Agent orchestration, tools, conversation
state, and UI run in Local MD Workspace. Model inference is the only remote
part: the browser calls OpenAI directly with a user-provided API key.

## Product Decisions

- Use Vercel AI SDK Core's `ToolLoopAgent` as the first Agent runtime, behind a
  provider-neutral local facade.
- Start with the OpenAI provider, default to `gpt-5.4-mini`, and allow the user
  to enter another OpenAI model ID.
- Keep the API key and model choice in page memory only. The key,
  `Authorization` header, and provider response bodies must not enter
  `localStorage`, `sessionStorage`, IndexedDB, URLs, telemetry, or logs. The
  provider origin is fixed to `https://api.openai.com/v1`.
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
- in-memory OpenAI API-key and model configuration with a fixed provider
  origin;
- streamed assistant text and summarized tool activity;
- Stop and New chat actions;
- workspace context, Markdown listing, reading, and bounded search;
- reading the unsaved active document from CodeMirror/Loro memory;
- version-bound exact replacements in the current document;
- structured conflict, truncation, unavailable, provider, and cancellation
  states;
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
WorkspaceAgentFeature / WorkspaceAgentPanel
        |
        v
useWorkspaceAgent
- messages / animation-frame-batched streaming / cancellation
        |
        v (dynamic import)
AI SDK adapter
- ToolLoopAgent / OpenAI provider / schemas / run budgets
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

The Agent panel, conversation controller, and SDK adapter never receive a raw
OpenDAL operator, `FileSystemHandle`, storage OAuth token, or mutable `LoroDoc`
handle. The workspace host owns those application capabilities. Workspace paths
and Markdown returned by tools are treated as untrusted model input. The SDK
adapter is a demand-loaded production chunk rather than part of the launcher
static closure.

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
  targetGeneration: number;
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
workspace identity, document ID, path, document and target generations, edit
version, content hash, editor/Loro agreement, the captured `EditorView`, and
cancellation state. A conflict lets the Agent reread and retry at most twice.

The write is a single `EditorView.dispatch` transaction tagged
`input.agent`. It deliberately does not mutate a separate Agent Loro peer. The
existing `loro-codemirror` binding turns that transaction into an ordinary
local operation on the main Loro peer, so normal undo, pending-update storage,
cross-tab broadcast, Grove Relay, and source autosave continue through their
existing paths.

## Initial Budgets

These defaults are deliberately conservative and may be tuned from browser
measurements:

| Budget                       |       Initial value |
| ---------------------------- | ------------------: |
| Catalog depth                |                  32 |
| Catalog directories/files    |          500 / 2000 |
| List page default/maximum    |            50 / 200 |
| Read window                  | 64 KiB or 400 lines |
| Search files                 |                 200 |
| Search input                 |               5 MiB |
| Per-file search              |             512 KiB |
| Search matches               |                 100 |
| Search snippet               |      240 characters |
| Local/cloud read concurrency |               4 / 2 |
| Minimum literal query        |        2 characters |
| Replacements per write       |                  32 |
| Edited document output       |             256 KiB |
| Agent steps per run          |                  12 |
| Stale retries                |                   2 |
| Default run timeout          |             120 sec |

Search is literal substring matching in the MVP. It reports scanned files,
bytes, matches, partial failures, and the budget that truncated a result. The
active document's unsaved value overrides its storage observation.
