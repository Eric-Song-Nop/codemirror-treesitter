# Browser Agent Contracts

Grove's Markdown Agent runs its UI, conversations, orchestration, and workspace
tools in Local MD Workspace. Only model inference is remote.

## Runtime

- Use Vercel AI SDK `ToolLoopAgent` and `Chat` behind SDK-independent domain
  contracts. Load the Agent UI on first open and `@ai-sdk/deepseek` on first run.
- Fix the provider origin to `https://api.deepseek.com`, default to
  `deepseek-v4-flash`, and allow only `deepseek-v4-pro` as an alternative.
- Keep independent `Chat` controllers in a private page-memory registry. New
  chat creates and selects one; switching does not interrupt other runs; Stop
  affects only the selected session. Workspace replacement and teardown stop all.
- Publish only immutable, non-secret summaries to React and Zustand. Session
  controllers, provider responses, raw tool payloads, and secrets stay behind
  private imperative boundaries.
- Expose the Agent only in local and cloud workspaces. Guest shares and
  standalone drafts have no Agent capability.
- Do not add conversation persistence, arbitrary network access, shell/eval/DOM
  automation, file lifecycle operations, a persistent index, or Agent-specific
  undo and rollback.

## Credential Vault

- Keep credentials in page memory by default. Only Agent Settings may explicitly
  save a key, and it writes only versioned AES-GCM ciphertext plus non-secret
  algorithm, KDF, random salt, and IV metadata to the dedicated
  `grove-agent-credentials` IndexedDB database.
- Derive a 256-bit AES-GCM key with PBKDF2-HMAC-SHA256, exactly 600,000
  iterations, and fresh random salt; use a fresh IV for every save. Never
  persist the passphrase or derived key. Every new page starts locked.
- The API key, passphrase, and derived key must not enter React/Zustand state,
  DOM refill, `localStorage`, `sessionStorage`, URLs, logs, telemetry,
  CacheStorage, or service-worker data.
- Missing Web Crypto or IndexedDB support and any save, unlock, or delete error
  fail closed without plaintext fallback. Lock and delete stop all runs and
  clear page-memory secrets. Delete removes the ciphertext or remains locked
  and warns that it may remain.
- Save, replace, and delete publish only an opaque random revision through
  BroadcastChannel or the `grove-agent-credentials:revision` storage-event
  fallback. Receiving it locks that tab and stops its runs.
- The vault protects a saved key only at rest. It does not protect against
  same-origin XSS, malicious extensions, a compromised browser profile, or code
  running while unlocked; resistance to offline guessing depends on passphrase
  strength.

DeepSeek's [disk context cache](https://api-docs.deepseek.com/guides/kv_cache/)
is enabled by default with no documented client opt-out. Local encryption and
page-memory conversations do not prevent temporary server-side retention of
request prefixes; disclose this before a user supplies or unlocks a key.

## Workspace Tools

The bounded tool set is:

```text
get_workspace_context
list_markdown_files
read_file
search_markdown
write_file
```

Resolve every content path through `WorkspaceRuntime.documents.document(path)`.
The collaborative document's current Loro value is authoritative even when the
file is not selected. Never give the Agent raw OpenDAL operators,
`FileSystemHandle`s, OAuth tokens, mutable `LoroDoc`s, or a selected editor view
as a storage shortcut.

Writes accept non-overlapping `{ from, to, expectedText, insert }` edits. Validate
them against one current snapshot and apply atomically through
`CollaborativeDocument.edit(...)`; conflicts and budget overflow make no partial
write. `flush()` reports source projection separately from the applied logical
Loro edit. Recovery, sync, editor views, and OpenDAL stay document-owned.

Listing, reading, literal search, writes, tool calls, concurrency, and run time
remain bounded by the domain defaults. Results report truncation and partial
failures; deduplicated retries do not consume another tool-call slot.
