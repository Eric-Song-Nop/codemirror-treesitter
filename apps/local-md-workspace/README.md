# local-md-workspace

Grove local-first Markdown workspace. It is a React app built around LiveMD,
the browser File System Access API, optional Dropbox storage through the OpenDAL
WASM wrapper, and optional shared-file collaboration through `apps/grove-relay`.
Its application layer uses a Zustand vanilla store for the React read model and
Effect services for typed asynchronous orchestration and resource lifecycles.
TanStack Query is limited to repeatable, cacheable reads such as trees,
directories, and image bytes; live collaboration documents belong to the
workspace runtime rather than query data or the selected editor view.
Those dependencies are app-only and do not enter LiveMD or other reusable core
packages.

## Responsibilities

- Open a browser-granted local directory and edit `.md` files with LiveMD.
- Restore previously granted local handles when browser permissions allow it.
- Connect to Dropbox with OAuth PKCE and use
  `@codemirror-treesitter/opendal-wasm-browser` for browser-side file
  operations.
- Route local-directory and cloud workspace content through one OpenDAL browser
  operator and `WorkspaceObjectStore`, with explicit revisions, conditional
  writes, readback verification, document-owned persistence ordering, and token
  renewal that never blindly replays an indeterminate mutation. Dropbox is the
  only cloud provider; the provider-neutral PKCE flow in
  `src/lib/workspace/providers/pkce-oauth.ts` is the extension point for adding
  another one.
- Build a Markdown file tree, create/rename/delete files and folders, materialize
  collaborative edits, and surface permission/storage errors. Local folder
  read/write permission is re-queried when the page becomes visible and before
  the first write after it was hidden; `NotAllowedError`/`SecurityError`
  failures map to `permission-denied`, writes are blocked until access returns,
  and a "Grant access again" banner re-prompts and resumes the selected
  document's pending save. Every opened
  workspace document remains monitored for its workspace lifetime:
  BrowserLocal uses a non-recursive `FileSystemObserver` on each immediate
  parent when available, with an adaptive authoritative polling fallback shared
  with cloud runtimes.
- Open a command palette with `Cmd/Ctrl+Shift+P` for file navigation and core
  workspace actions.
- Run switchable page-memory Agent chats across local or Dropbox Markdown, with
  exact writes and an optional passphrase-locked DeepSeek-key vault.
- Insert pasted, dropped, or selected image files into sibling `assets/`
  directories and resolve Markdown image previews through blob URLs.
- Export Markdown files to standalone HTML through LiveMD's Tree-sitter
  Markdown renderer, embedding workspace image assets when available and
  snapshotting the current LiveMD theme variables for scoped document styling.
- Open a browser print view for Markdown documents so users can print or save
  the rendered document as PDF through the browser.
- Maintain one Loro-backed document for every opened workspace path so local,
  remote, cross-tab, and external-file changes share one content authority even
  while the file is not selected. Documents are reference-counted: editor views
  and in-flight Agent edits retain them, unretained documents close after 60 s
  idle, and an LRU cap of 32 evicts the oldest idle documents. Documents with
  unsaved changes are never evicted.
- Create, rotate, revoke, and host shared-file links through the Grove relay.
  The share host secret (the bearer for hosting, `/rotate`, and `/revoke`) is
  read from page memory first and persisted in `localStorage` so the owner can
  re-host, rotate, or revoke from a new tab; it is forgotten after revocation.
  Threat model: the host secret is stored at rest unencrypted in the browser
  profile. This protects against nothing on a compromised profile or under
  XSS. If the product accepts a passphrase prompt for sharing, a
  passphrase-locked vault like the Agent credential vault is the available
  upgrade.
- Open guest shared-file routes and sync through the relay without requiring
  access to the owner's local or cloud workspace.
- Refresh expired Grove relay sessions automatically for guests and owner
  hosts, while retaining queued/offline document edits across the reconnect.
- Switch the full workspace, shared-file route, LiveMD editor chrome, nested
  code highlighting, and file tree between named Gruvbox, GitHub Light, and
  Catppuccin themes.
- Install as a PWA with an app manifest and production service worker for the
  app shell, icons, same-origin static assets, and the lazy collaboration
  runtime needed to open local or shared files while offline.
- Surface transient LiveMD language initialization failures with an in-page
  retry that reloads the language service and remounts the active editor.

## Source Layout

- `src/app/workspace-store.ts`: app-owned Zustand vanilla state and atomic
  selected/loading document-view publication operations.
- `src/app/document-view-coordinator.ts`: latest-request workspace document
  preparation, view replacement, and selected subscription cleanup. It uses
  standard abort signals for stale UI work and never flushes or closes a
  collaborative document.
- `src/app/workspace-application.ts` and
  `src/app/WorkspaceApplicationProvider.tsx`: the StrictMode-external app
  lifetime and stable React composition boundary.
- `src/app/effect-runtime.ts`: the app-owned Effect `ManagedRuntime` and its
  service layer (workspace runtime transitions, local and cloud storage,
  Dropbox sessions, OpenDAL operators).
- `src/app/effect-bridge.ts`: the only place UI code runs Effects
  (`runWorkspaceEffect`, `useWorkspaceEffectRunner`): typed failures reject as
  their `Error`, interruption rejects as an `AbortError`, and hook-run effects
  are interrupted on unmount.
- `src/App.tsx`: i18n boundary and route shell for the workspace and shared-file
  editor.
- `src/components/workspace/LocalWorkspaceApp.tsx`: main local workspace
  composition root for restore flow, file operations, image assets, sharing,
  owner hosting, and conflict handling. It subscribes only to low-frequency
  store fields through `useWorkspaceRootState`; the containers in
  `WorkspaceChrome.tsx` subscribe to save state, busy flags, error text, and
  editor versions themselves.
- `src/hooks/workspace/workspace-editor-session.ts`: the non-React editor
  session that owns selected-document state, standalone autosave, collaborative
  save status, document switching, runtime replacement, and folder-access
  re-grant. Zustand holds only plain keys and status; the live runtime, the
  displayed collaborative document, and the editor text live in
  `workspaceLiveObjects(store)`.
- `src/components/LiveMdEditor.tsx`: React wrapper for the LiveMD custom
  element and image input handling.
- `src/components/FileTree.tsx`: Markdown tree navigation and file/folder
  actions.
- `src/components/SharedFileEditor.tsx`: guest shared-file route and relay
  connection UI.
- `src/i18n/*.json` and `src/lib/i18n.tsx`: English/Chinese i18next resources,
  react-i18next hooks, locale persistence, and known error-message
  localization.
- `src/theme/*`: shared named-theme contract, document/storage adapters, and
  CSS token ownership for the local and shared workspace routes.
- `src/lib/workspace/*`: workspace tree/path rules, document and source state,
  browser file handles, single-file drafts, persistence metadata, status, and
  user-facing workspace errors.
- `src/lib/workspace/documents/*`: normalized-path collaborative document
  registry, Loro authority, browser recovery, external reconciliation, and the
  coalescing filesystem materializer.
- `src/lib/workspace/providers/*`: shared OpenDAL workspace identity, typed
  OAuth errors (`oauth-errors.ts`), the provider-neutral Effect OAuth PKCE
  client (`pkce-oauth.ts`: S256 only, 64-byte state and verifier,
  origin-checked popup `postMessage`, verifier in `sessionStorage` only during
  a full-page redirect, popup closed on interruption), and the Dropbox provider
  directory (configuration, redirect drafts, its PKCE provider config, and the
  `DropboxWorkspaces` service with a single in-flight authorization).
- `src/lib/workspace/storage/*`: tagged storage errors (`errors.ts`), the
  Effect object storage contract, scoped OpenDAL operator hosts with bounded
  transient retries and single-flight credential renewal, explicit
  revision/CAS policy, indeterminate outcomes, and scoped cross-tab path locks.
- `src/lib/workspace/runtime/*`: focused tree, entry, asset, and low-level source
  ports (the Promise facade over the Effect store); scoped BrowserLocal/cloud
  runtime assembly (`LocalWorkspaceStorage`, `CloudWorkspaceStorage`,
  `runtime-scope.ts`); BrowserLocal folder-permission tracking
  (`local-permission.ts`); per-document observation; and the
  `WorkspaceRuntimeTransitions` service that owns the active runtime's scope.
- `src/lib/workspace/workspace-data-cache.ts` and `query-keys.ts`: the narrow
  TanStack Query boundary for discardable workspace read data. They do not
  cache collaboration documents or runtime handles.
- `src/hooks/workspace/useDropboxWorkspaceRuntime.ts`: React adapter that
  supplies UI context (redirect draft, localized name) to `DropboxWorkspaces`
  and persists the chosen configuration.
- `src/lib/platform/*`: browser capability detection, PWA registration, and
  installed-PWA share-target launch handling.
- `src/lib/editor/*`: React-side LiveMD initialization and retry state.
- `src/lib/export/markdown-html.ts`: standalone HTML export wrapper, LiveMD
  theme snapshotting, and workspace image embedding.
- `src/lib/export/browser-print.ts`: browser print-view helper for standalone
  Markdown HTML.
- `src/lib/export/workspace-file.ts`: localized export naming, warnings, and
  browser download handling.
- `src/lib/collaboration/*`: local Loro document persistence, share identity,
  relay protocol, typed relay errors (`relay-errors.ts`), the Effect relay
  client, the relay connection (an Effect-managed WebSocket lifetime with a
  reconnect `Schedule`), share storage, Markdown hashing, and
  document sync helpers. `markdown-document.ts` is a lightweight facade; it loads
  `markdown-document-runtime.ts` only when a file is opened.
- `src/lib/agent/domain` and `src/lib/agent/application`: SDK-independent tool
  contracts, budgets, host/run ports, policies, workspace read/search use cases,
  and the run-scoped idempotency/retry session.
- `src/lib/agent/adapters/{workspace,ai-sdk}` and `providers/deepseek`: workspace
  host, AI SDK runner, isolated model binding, and demand-loaded facades.
- `src/features/workspace-agent`: lazy panel, private sessions and credential
  vault, run-host hook, safe chat transport, and component tests.
- `src/components/ui/*`: local shadcn/radix UI primitives.
- `scripts/dev.mjs`: starts the local Grove relay when needed, then starts the
  frontend with `VITE_LOCAL_MD_SHARE_RELAY_ORIGIN`.
- `service-worker-precache-plugin.ts` and
  `scripts/check-production-bundle.mjs`: derive and verify the launcher, lazy
  collaboration, and critical offline asset closures used by the production
  service worker.
- `smoke/ui-smoke.mjs`: headless Chrome UI smoke for local, sharing, conflict,
  and Dropbox UI flows.

## Storage Architecture

- [Collaborative Document Migration](./COLLABORATIVE_DOCUMENT_MIGRATION.md):
  target document authority, lifecycle invariants, materializer semantics, and
  stacked delivery plan.
- [OpenDAL Workspace Storage Architecture](./OPENDAL_WORKSPACE_ARCHITECTURE.md):
  implemented browser operator, workspace object storage, explicit source
  states, path-scoped persistence, and external-source reconciliation
  contracts.
- [Browser Agent Architecture](./BROWSER_AGENT_PLAN.md): browser-side workspace
  tools, path-based collaborative-document editing, BYOK boundaries, and
  resource budgets.
- [Effect and Zustand boundaries](./EFFECT_ZUSTAND_MIGRATION.md): app-only
  dependency boundary, the Effect service/layer map, scoped runtime lifetimes,
  the tagged error model, retry schedules, and how the UI calls Effects.

## Configuration

Optional Dropbox configuration:

```env
VITE_DROPBOX_APP_KEY="your-public-dropbox-app-key"
VITE_DROPBOX_REDIRECT_URI="http://localhost:5173/"
```

Optional relay configuration:

```env
VITE_LOCAL_MD_SHARE_RELAY_ORIGIN="http://127.0.0.1:8787"
```

If the relay origin is local, `vp run local-md-workspace#dev` starts
`apps/grove-relay` automatically unless an existing relay responds at
`/__debug`.

## Browser Agent

The Agent runs in the page against the fixed `https://api.deepseek.com` origin.
It defaults to `deepseek-v4-flash`; only `deepseek-v4-pro` is also allowed.
Independent page-memory chats may stream concurrently, switching preserves
their drafts, Stop affects only the selected chat, and workspace teardown stops
all. Conversations are never persisted.

Credentials stay in page memory unless Agent Settings explicitly saves
AES-GCM ciphertext in dedicated IndexedDB. A non-persisted passphrase uses
PBKDF2-HMAC-SHA256, 600,000 iterations, and random salt; every page starts
locked. Secrets stay out of UI state, DOM refill, web storage, URLs, logs,
caches, and service-worker data. Failures close safely without plaintext.
Lock/delete stop all runs and clear memory; delete removes the record or warns.

Cross-tab changes carry only an opaque revision; receiving one locks the tab.
The vault protects only at rest, not against XSS, extensions, a compromised
profile, or unlocked-page code. DeepSeek's
[disk context cache](https://api-docs.deepseek.com/guides/kv_cache/) has no
documented client opt-out, so request prefixes may be retained remotely.

The bounded tools get workspace context, list/read/search Markdown, and apply
exact edits. All content resolves through workspace-owned collaborative
documents; selected and unselected files share the same Loro authority. Writes
validate expected text atomically, then flush source projection separately from
the applied logical edit. Guest shares, standalone drafts, arbitrary network,
shell/eval/DOM automation, file lifecycle operations, persistent indexes, and
conversation persistence are excluded.

Every tool call shows its target path (or directory/query) in the panel, and
each write shows a line-count summary and a short diff (capped at 40 lines).
Writes to the document open in the editor apply directly. A write to any other
file blocks at tool execution until the user clicks **Allow once**, **Allow
this file for this chat**, or **Deny**; denial, Stop, or teardown rejects the
write with `reason: "denied"` and nothing is committed. Each chat lists its
applied edits ("Edited <path>") with a one-click **Revert** that reapplies the
pre-edit text through the shared Loro document (resolved via
`WorkspaceRuntime.documents.document(path)`); revert refuses when the edited
span has changed since. Agent edits and reverts commit with the
`live-md:external-edit` origin and are excluded from the user's undo stack.
read/search/list results reach the model inside nonce-delimited
`<untrusted-workspace-content>` blocks, and the system policy states their
contents are data, not commands.

The UI loads on first panel open and the AI SDK/DeepSeek adapter on first run;
the model runtime stays outside the launcher and offline precache. See
[Browser Agent Contracts](./BROWSER_AGENT_PLAN.md) for the authoritative
security, tool, lifecycle, and budget rules.

## PWA Support

The app ships `public/site.webmanifest` and `public/service-worker.js`. The
service worker is registered only for production builds, so normal
`dev:frontend` sessions do not keep stale development assets. Use
`vp run local-md-workspace#build` followed by `vp run local-md-workspace#preview`
to test installability and offline app-shell loading.

The service worker caches same-origin GET navigations and static assets. Cloud
storage requests, relay API mutations, and relay WebSockets remain network-only.
The initial app shell does not execute or compile Loro, AI SDK, or the
`@ai-sdk/deepseek` provider. Collaboration code and its WASM runtime load only
when a workspace file or shared-file route is opened; the Agent UI loads when
its panel first opens, and the model runtime loads only when a run starts.
Production builds inject the launcher and collaboration static closures, Loro
WASM, the Tree-sitter runtime, the Markdown block and inline
grammars, and their highlight-query dependencies into a content-keyed offline
precache. The optional Agent chunks are not part of the required offline closure.
Installation fails closed if a critical asset is unavailable.
`vp run local-md-workspace#bundle:check` verifies these boundaries and caps
bundled Tree-sitter grammars to LiveMD's focused set. Code-fence parsers are
fetched and compiled only after a supported fence alias appears in the document
and remain outside the critical offline precache.

Run `vp run local-md-workspace#smoke:agent` for the focused Chromium fake-model,
IndexedDB reopen, credential-vault lock/unlock, and secret-boundary checks. The
broader `vp run local-md-workspace#smoke:ui` includes the same Agent assertions.

On Android browsers that support the Web Share Target API for installed PWAs,
Grove registers as a share target for Markdown files. Shared `.md` and
`.markdown` files are imported as single-file drafts stored in browser storage.
They do not retain write access to the original file or its containing folder;
use Save As, Save As Dropbox, or Download copy after editing.

## Commands

Run from the workspace root:

```bash
vp run local-md-workspace#dev
vp run local-md-workspace#dev:frontend
vp run local-md-workspace#build
vp run local-md-workspace#bundle:check
vp run local-md-workspace#i18n:check
vp run local-md-workspace#test
vp run local-md-workspace#preview
vp run local-md-workspace#smoke:agent
vp run local-md-workspace#smoke:ui
```

The UI smoke requires a Chromium/Chrome binary. Set `CHROME_PATH` if it is not
discoverable. Real Dropbox storage checks additionally require
`LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN` or `OPENDAL_DROPBOX_ACCESS_TOKEN`.

To run only the real-browser LiveMD preview-boundary and selection regressions
against an already running page that registers `<live-md-editor>`, set both the
page URL and the focused-mode flag. Run the smoke script directly so Vite Task's
clean environment does not discard these focused-mode variables:

```bash
LOCAL_MD_WORKSPACE_SMOKE_URL=http://127.0.0.1:5174/ \
LOCAL_MD_WORKSPACE_SMOKE_LIVE_MD_BOUNDARIES_ONLY=1 \
node apps/local-md-workspace/smoke/ui-smoke.mjs
```

The focused smoke checks that Mermaid, image, and table previews reveal their
source from across the rendered surface while the following blank line remains
editable from its full width. It also performs a real pointer drag inside a
fenced code block and checks the final Chromium pixels for a visible selection
edge, alongside the copy and pointer-through assertions.
