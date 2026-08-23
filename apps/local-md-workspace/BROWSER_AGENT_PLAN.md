# Browser Agent Implementation Plan

This document records the implementation and delivery contract for Grove's
browser-resident Markdown Agent. The Agent orchestration, tools, conversation
state, and UI run in Local MD Workspace. Model inference is the only remote
part: the browser calls OpenAI directly with a user-provided API key.

The work is delivered as a GitHub stacked-PR series. Each PR must remain useful,
reviewable, and tested when checked out on top of its declared base branch.

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

## Stacked Pull Requests

### PR 1: Plan and workspace read/search foundation

- Branch: `feat/markdown-agent`
- Base: `main`
- Pull request: [#114](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/114)
- Persists this plan and adds SDK-independent contracts, limits, catalog
  traversal, active-document read override, bounded concurrent search, and
  focused tests.

### PR 2: Versioned current-document edit bridge

- Branch: `feat/markdown-agent-edit`
- Base: `feat/markdown-agent`
- Pull request: [#115](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/115)
- Adds compound active-document version tokens, exact replacement validation,
  and one `input.agent` CodeMirror transaction.
- Verifies immediate LiveMD updates, normal undo, local Loro updates, and stale
  rejection without adding a second persistence or relay path.

### PR 3: Browser AI SDK runtime

- Branch: `feat/markdown-agent-runtime`
- Base: `feat/markdown-agent-edit`
- Pull request: [#116](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/116)
- Adds `ai`, `@ai-sdk/openai`, schema validation, the provider-neutral runtime
  facade, tool schemas, OpenAI BYOK, instructions, budgets, cancellation, and
  tool-call deduplication.
- Uses a scripted fake model to cover search, read, conflict, reread, edit, and
  final response without a provider key.

### PR 4: Agent panel and BYOK flow

- Branch: `feat/markdown-agent-ui`
- Base: `feat/markdown-agent-runtime`
- Pull request: [#117](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/117)
- Adds the header entry point, responsive Agent panel, messages, safe summarized
  tool activity, in-memory API-key/model settings, Send, Stop, and New chat.
- Binds a run to its starting workspace document and cancels it on panel close,
  document switch, workspace replacement, or standalone-file transition.
- Adds English/Chinese strings, keyboard and IME behavior, focus management,
  modal semantics, and live status announcements.

### PR 5: Integration, bundle, and release contract

- Branch: `test/markdown-agent-integration`
- Base: `feat/markdown-agent-ui`
- Pull request: [#118](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/118)
- Connect a scripted AI SDK model to the real workspace host,
  LiveMD/CodeMirror, main Loro peer, and browser pending-update persistence.
- Verify that an Agent edit emits one local Loro update and survives document
  reopen, while a scope switch fails closed without an update.
- Assert from the production Vite manifest that the AI SDK/OpenAI runtime entry
  emits as a lazy JavaScript chunk outside the launcher static closure. Exercise
  that rule with a synthetic-manifest regression without requiring the optional
  Agent chunk in the offline precache.
- Finish app/root documentation and agent-facing repository notes.

## Required Validation

Each PR runs its focused tests. Run this complete matrix at the top of the
stack:

```bash
vp check
vp run local-md-workspace#i18n:check
vp run local-md-workspace#test
vp run local-md-workspace#build
vp run local-md-workspace#bundle:check
vp run local-md-workspace#smoke:agent
vp run local-md-workspace#smoke:ui
vp run grove-relay#test
vp run @codemirror-treesitter/live-md-loro#test
vp run -r test
```

The focused `smoke:agent` task is the browser Agent gate. The broader `smoke:ui`
also executes those Agent assertions before continuing through the app's
unrelated workspace, collaboration, Dropbox, and LiveMD browser regressions.

A real-provider smoke remains manual and non-PR-blocking because it requires a
user-provided key. It must never print or persist that key. Deterministic CI and
local integration tests use AI SDK's fake language model instead.

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
- The AI SDK/OpenAI runtime remains a lazy chunk outside the launcher static
  closure. Offline precaching of that optional chunk is not required, and
  remote inference always requires network access.
- Existing workspace, collaboration, PWA, and LiveMD behavior has no regression.
