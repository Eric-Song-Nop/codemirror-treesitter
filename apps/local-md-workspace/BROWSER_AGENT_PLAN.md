# Browser Agent Architecture and Contracts

This document records the lasting implementation contract for Grove's
browser-resident Markdown Agent. The Agent orchestration, tools, conversation
state, and UI run in Local MD Workspace. Model inference is the only remote
part: the browser calls DeepSeek directly with a user-provided API key.

## Product Decisions

- Use Vercel AI SDK Core's `ToolLoopAgent`, AI SDK UI `useChat`, and shadcn/ui
  primitives behind a provider-neutral local facade.
- Use `@ai-sdk/deepseek`, default to `deepseek-v4-flash`, and expose only
  `deepseek-v4-pro` as a manual model choice. Do not accept free-form model IDs.
- Keep the API key and model choice in page memory only. The key,
  `Authorization` header, and provider response bodies must not enter
  `localStorage`, `sessionStorage`, IndexedDB, URLs, telemetry, or logs. The
  provider origin is fixed to `https://api.deepseek.com`.
- Run the MVP Agent on the browser main thread. Remote streaming and workspace
  I/O are asynchronous; a Worker becomes relevant only for local inference or
  a CPU-heavy long-lived index.
- Allow workspace-wide Markdown listing, reading, literal text search, and
  exact writes through the workspace document registry.
- Treat an Agent edit as another actor input to the shared Loro document. Do not
  add a persistent Agent peer, inverse updates, selective Agent undo, run
  rollback, or per-edit approval.
- Apply Agent changes through `CollaborativeDocument.edit(...)`; bound
  CodeMirror views subscribe to that authority, while browser persistence,
  cross-tab transport, relay, and source materialization stay document-owned.
- Reject stale intent before editing. CRDT convergence does not make a model's
  edit semantically correct when the user or another peer changed its base.
- Keep Agent domain contracts SDK-independent; UI state retains only text and
  generic tool status so another browser runtime can replace AI SDK later.

## MVP Scope

The MVP includes:

- an Agent panel in the workspace route;
- in-memory DeepSeek API-key and two-model selection with a fixed provider
  origin;
- streamed assistant text and summarized tool activity;
- Stop and New chat actions;
- workspace context, Markdown listing, reading, and bounded search;
- reading selected or unselected files from their shared Loro documents;
- expected-text exact edits to any exposed workspace Markdown file;
- structured conflict, truncation, unavailable, provider, and cancellation
  states;
- normal Loro undo, browser persistence, BroadcastChannel, Grove Relay, and
  OpenDAL autosave behavior;
- English and Simplified Chinese UI;
- lazy loading so Agent dependencies do not enter the launcher bundle.

The MVP excludes:

- guest shared-file and standalone-file Agent entry points;
- create, rename, move, delete, or multi-file transactions;
- an Agent-specific undo stack or proposal/fork workflow;
- conversation persistence;
- arbitrary URL fetching, shell, eval, DOM automation, or dynamic tools;
- WebLLM, browser Prompt APIs, embeddings, or a persistent search index.

## Architecture

```text
features/workspace-agent
- WorkspaceAgentFeature / WorkspaceAgentPanel (shadcn/ui)
- useWorkspaceAgent / AI SDK UI useChat
- safe UIMessage state / cancellation / transport
        |
        v (runtime.ts dynamic import)
lib/agent/ai-sdk-runtime.ts composition root
- providers/deepseek `@ai-sdk/deepseek` model binding
- adapters/ai-sdk ToolLoopAgent runner / schemas
        |
        v
application run-scoped tool session
- SDK-independent call idempotency / stale-edit retry policy
        |
        v
application host port / adapters/workspace
- provider-neutral tools / workspace and active-editor capabilities
        |
        +-- WorkspaceRuntime tree/documents --> OpenDAL
        |
        `-- EditorView.dispatch
              --> loro-codemirror main-peer commit
              --> IndexedDB pending log
              --> BroadcastChannel / Grove Relay
              --> LiveMD input / autosave / OpenDAL materialization
```

The panel, controller, transport, and SDK adapter never receive a raw OpenDAL
operator, `FileSystemHandle`, storage OAuth token, or mutable `LoroDoc` handle.
The workspace host owns those capabilities. The SDK-independent tool session is
created for each run and owns call-id deduplication and stale-edit retry state;
an SDK adapter only supplies schemas and execution metadata. Workspace paths
and Markdown are untrusted model input; the transport strips raw tool IDs,
inputs, and outputs from `UIMessage` state. Agent UI and model code remain
separate demand-loaded chunks outside the launcher static closure.

## DeepSeek Context Cache

DeepSeek's
[disk context cache](https://api-docs.deepseek.com/guides/kv_cache/) is enabled
by default for API requests, and its public API documents no client-side
opt-out. DeepSeek documents that each user's cache is isolated and logically
invisible to other users, and that unused cache entries are normally cleared
within a few hours to days. The page-memory-only credential and conversation
policy therefore prevents Grove from persisting those values locally, but it
does not prevent request prefixes from being retained temporarily in
DeepSeek's server-side cache. The Agent UI must disclose this boundary before a
user supplies a key.

## Tool Contract

The first tool set is:

```text
get_workspace_context
list_markdown_files
read_file
search_markdown
write_file
```

`read_file` resolves the path through `WorkspaceRuntime.documents` and returns
the current Loro value plus absolute UTF-16 offsets for the requested window.
The selected CodeMirror view has no authority or write capability that an
unselected document lacks.

The write tool accepts exact offset edits:

```ts
type AgentTextEdit = {
  from: number;
  to: number;
  expectedText: string;
  insert: string;
};
```

Every range is checked against `expectedText` in one current document snapshot;
ranges must be valid and non-overlapping. Conflicts and oversized output produce
a structured result with no partial write. Successful edits enter the shared
Loro document synchronously, then `flush()` waits for their filesystem
projection. A projection error is reported separately from the already-applied
logical edit so the Agent does not repeat it.

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
| Exact edits per write        |                  32 |
| Edited document output       |             256 KiB |
| Agent steps per run          |                  12 |
| Unique tool calls per run    |                  12 |
| Default run timeout          |             120 sec |

Search is literal substring matching in the MVP. It reports scanned files,
bytes, matches, partial failures, and the budget that truncated a result. The
collaborative document's current value overrides its storage projection. The unique
tool-call budget counts first-seen tool-call IDs; a deduplicated retry of the
same ID does not consume another slot.
