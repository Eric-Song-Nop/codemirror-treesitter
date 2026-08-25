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
- Keep the API key in page memory by default. Persist it only after an explicit
  save in Agent Settings and only as a versioned AES-GCM ciphertext record in
  the dedicated `grove-agent-credentials` IndexedDB database. Keep the model
  choice in page memory. The provider origin is fixed to
  `https://api.deepseek.com`.
- Derive the vault AES-GCM key locally from a non-persisted vault passphrase
  using PBKDF2-HMAC-SHA256, exactly 600,000 iterations, and a random salt. Every
  newly opened or reloaded page starts locked and requires the passphrase to
  unlock a saved credential.
- Keep the API key, vault passphrase, derived key, `Authorization` header, and
  provider response bodies out of React/Zustand state, DOM refill,
  `localStorage`, `sessionStorage`, URLs, logs, telemetry, CacheStorage, and the
  service worker. If Web Crypto or IndexedDB is unavailable, or a vault
  operation fails, fail closed and never fall back to plaintext persistence.
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
- Keep a page-memory registry of independent AI SDK `Chat` controllers. New
  chat creates and selects a controller, session switching does not interrupt
  other controllers, and Stop targets only the selected session. Workspace
  replacement and app teardown stop the whole registry.
- Keep unlocked API credentials and all vault secret material behind a private
  imperative boundary and publish only safe, immutable credential and session
  summaries through the React-facing Zustand store. Lock and delete clear
  page-memory secret material and stop all running sessions; delete also
  removes the encrypted vault record.

## MVP Scope

The MVP includes:

- an Agent panel in the workspace route;
- page-memory DeepSeek API key, an optional explicitly saved encrypted vault,
  Settings actions to save, unlock, lock, and delete it, and two-model selection
  with a fixed provider origin;
- streamed assistant text and summarized tool activity;
- concurrent page-memory conversations with visible switching, per-session
  drafts, and session-scoped Stop and New chat actions;
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
- WorkspaceAgentSessionManager / Zustand session summaries
- Agent Settings / private credential-vault controller / safe status summaries
- one AI SDK UI Chat per session / active useChat subscription
- safe UIMessage state / session-scoped cancellation / transport
        |
        +-- dedicated IndexedDB `grove-agent-credentials`
        |     --> versioned AES-GCM ciphertext and non-secret metadata only
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
- provider-neutral path-based workspace tools
        |
        +-- WorkspaceRuntime.tree --> Markdown discovery
        |
        `-- WorkspaceRuntime.documents.document(path)
              --> CollaborativeDocument.edit(exactEdits)
              --> Loro logical authority
                    +-- CodeMirror subscribers
                    +-- IndexedDB recovery
                    +-- BroadcastChannel / Grove Relay
                    `-- OpenDAL materializer
```

The panel, controller, transport, and SDK adapter never receive a raw OpenDAL
operator, `FileSystemHandle`, storage OAuth token, or mutable `LoroDoc` handle.
The workspace host owns those capabilities. The SDK-independent tool session is
created for each run and owns call-id deduplication and stale-edit retry state;
an SDK adapter only supplies schemas and execution metadata. Workspace paths
and Markdown are untrusted model input; the transport strips raw tool IDs,
inputs, and outputs from `UIMessage` state. Agent UI and model code remain
separate demand-loaded chunks outside the launcher static closure.

## Credential Vault Contract

Agent Settings is the only surface allowed to persist a DeepSeek API key. A
save creates a versioned record in the dedicated `grove-agent-credentials`
IndexedDB database containing only AES-GCM ciphertext and the non-secret
algorithm, KDF, random salt, and IV metadata required to unlock it. A fresh
random salt and IV are used for each saved record. No plaintext credential is
written to storage.

The AES-GCM key is derived locally from the vault passphrase using
PBKDF2-HMAC-SHA256 with exactly 600,000 iterations, matching the
[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
work factor for this algorithm. The passphrase and derived key are never
persisted. A new page instance never auto-unlocks from stored data: it reports
that a saved vault exists, remains locked, and requires the user to enter the
passphrase before decrypting the API key into page memory.

The API key, passphrase, and derived key stay out of React and Zustand state,
DOM value refill, `localStorage`, `sessionStorage`, URLs, logs, telemetry,
CacheStorage, and service-worker messages or caches. UI state may contain only
non-secret facts such as whether a saved vault exists, whether it is locked,
and a sanitized operation error. Missing Web Crypto or IndexedDB support and
any save, unlock, or delete failure are terminal for that operation: the UI
reports the failure and never stores plaintext as a fallback.

Lock and delete first stop all Agent runs and clear the decrypted API key,
passphrase, derived key, and other vault secret material from page memory.
Delete also removes the encrypted record; if that removal fails, the UI reports
that encrypted data may remain while the current page stays locked. The fixed
DeepSeek origin and model allowlist apply equally to unlocked saved keys.

Save, replace, and delete broadcast a non-secret random revision to other tabs.
BroadcastChannel is the primary transport; a `storage` event using
`grove-agent-credentials:revision` is the fallback. That token contains no key,
passphrase, ciphertext, or unlock capability. Receiving either signal locks the
tab synchronously and stops all of its Agent runs.

This vault is an at-rest protection boundary, not a claim that browser-held
credentials are immune to hostile code; its resistance to offline guessing
also depends on passphrase strength. The
[Web Cryptography API security considerations](https://www.w3.org/TR/WebCryptoAPI/#security-considerations)
explicitly warn that script injection can exfiltrate keys and data. Same-origin
XSS, malicious extensions, a compromised browser profile, or code executing in
an unlocked page can therefore still read or use secrets available to that
page. The Settings UI must disclose these residual risks and make lock and
delete outcomes explicit.

## DeepSeek Context Cache

DeepSeek's
[disk context cache](https://api-docs.deepseek.com/guides/kv_cache/) is enabled
by default for API requests, and its public API documents no client-side
opt-out. DeepSeek documents that each user's cache is isolated and logically
invisible to other users, and that unused cache entries are normally cleared
within a few hours to days. Grove's local vault can persist only encrypted
credential data, and conversations remain page-memory-only, but neither rule
prevents request prefixes from being retained temporarily in DeepSeek's
server-side cache. The Agent UI must disclose this boundary before a user
supplies or unlocks a key.

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
