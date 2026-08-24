# local-md-workspace

Grove local-first Markdown workspace. It is a React app built around LiveMD,
the browser File System Access API, optional Dropbox storage through the OpenDAL
WASM wrapper, and optional shared-file collaboration through `apps/grove-relay`.

## Responsibilities

- Open a browser-granted local directory and edit `.md` files with LiveMD.
- Restore previously granted local handles when browser permissions allow it.
- Connect to Dropbox with OAuth PKCE and use
  `@codemirror-treesitter/opendal-wasm-browser` for browser-side file
  operations.
- Route local-directory and cloud workspace content through one OpenDAL browser
  operator and `WorkspaceObjectStore`, with explicit revisions, conditional
  writes, readback verification, path-scoped persistence ordering, and token
  renewal that never blindly replays an indeterminate mutation. OneDrive and
  Google Drive runtime construction exists in source, but those providers are
  not exposed in the current Grove UI.
- Build a Markdown file tree, create/rename/delete files and folders, autosave
  edits, and surface permission/storage errors. Only the active workspace
  document is monitored: BrowserLocal uses a non-recursive
  `FileSystemObserver` on its immediate parent when available, with an adaptive
  authoritative polling fallback shared with cloud runtimes.
- Open a command palette with `Cmd/Ctrl+Shift+P` for file navigation and core
  workspace actions.
- Run a browser-resident Markdown Agent that can list, read, and search the
  active local or Dropbox workspace and apply version-checked exact
  replacements to the active workspace document.
- Insert pasted, dropped, or selected image files into sibling `assets/`
  directories and resolve Markdown image previews through blob URLs.
- Export Markdown files to standalone HTML through LiveMD's Tree-sitter
  Markdown renderer, embedding workspace image assets when available and
  snapshotting the current LiveMD theme variables for scoped document styling.
- Open a browser print view for Markdown documents so users can print or save
  the rendered document as PDF through the browser.
- Maintain optional Loro-backed document state for a selected file so local
  edits can become a shared Grove file.
- Create, rotate, revoke, and host shared-file links through the Grove relay.
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

- `src/App.tsx`: main local workspace state machine, restore flow, file
  operations, autosave, image assets, share creation, owner hosting, and
  conflict handling.
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
- `src/lib/workspace/providers/*`: provider-specific OAuth, redirect drafts,
  configuration, and shared OpenDAL workspace identity. Dropbox, Google Drive,
  and OneDrive each own a dedicated provider directory.
- `src/lib/workspace/storage/*`: provider-neutral object storage contract,
  exact OpenDAL operator lifetime, explicit revision/CAS policy, indeterminate
  outcomes, and cross-tab path locking.
- `src/lib/workspace/runtime/*`: focused tree, entry, asset, and document ports;
  BrowserLocal/cloud runtime assembly; active-document observation; and the
  document persistence coordinator.
- `src/hooks/workspace/use*WorkspaceRuntime.ts`: OAuth-aware provider runtime
  construction. Dropbox is used by the current Grove UI; Google Drive and
  OneDrive remain dormant.
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
  relay protocol/client/connection, share storage, Markdown hashing, and
  document sync helpers. `markdown-document.ts` is a lightweight facade; it loads
  `markdown-document-runtime.ts` only when a file is opened.
- `src/lib/agent/*`: SDK-independent workspace tool contracts and limits,
  active-document version checks, the CodeMirror edit bridge, the lazy runtime
  facade, the safe AI SDK UI transport, and the Vercel AI SDK/OpenAI adapter.
- `src/hooks/agent/*` and `src/components/workspace/WorkspaceAgent*`: the
  run-scoped capability, AI SDK UI `useChat` controller, and shadcn-based panel;
  component tests use `@shadcn/helpers/ai-sdk` fixtures.
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

- [OpenDAL Workspace Storage Architecture](./OPENDAL_WORKSPACE_ARCHITECTURE.md):
  implemented browser operator, workspace object storage, explicit source
  states, path-scoped persistence, and current-document reconciliation
  contracts.
- [Browser Agent Architecture](./BROWSER_AGENT_PLAN.md): browser-side workspace
  tools, active-document editing, BYOK boundaries, and resource budgets.

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

The workspace header opens an Agent panel whose orchestration and tools run in
the page. The first model adapter uses Vercel AI SDK Core and calls the fixed
OpenAI API origin directly. Enter an OpenAI API key in the panel; there is no
build-time or product API-key environment variable. The key and selected model
remain in page memory and are cleared by a reload; **Forget key** clears the key
without storing it elsewhere. Neither value is written to browser storage,
URLs, telemetry, or logs. The default model is `gpt-5.4-mini`.

The available tools are:

- `get_workspace_context`
- `list_markdown_files`
- `read_markdown`
- `search_markdown`
- `apply_current_document_edits`

Listing, reading, and literal search can inspect Markdown files across the
active local or Dropbox workspace. The unsaved active document is read from the
live editor; inactive files are read-only. Writes are limited to exact unique
replacements in the workspace document bound when the run starts. The host
validates workspace, document, path, editor, generation, version, and content
hash immediately before applying all replacements in one transaction.

Agent writes use
`EditorView.dispatch({ changes, userEvent: "input.agent" })`.
The existing `loro-codemirror` binding commits that input on the main Loro peer,
which preserves ordinary undo and routes the update through the existing
IndexedDB pending log, BroadcastChannel, Grove Relay, autosave, and OpenDAL
materialization paths. There is no separate Agent CRDT peer, selective Agent
undo, edit approval queue, or cross-file write path.

The current Agent is available only for local/cloud workspace routes. Guest
shared files and standalone-file drafts do not receive an Agent capability. It
does not provide arbitrary web fetch, shell, JavaScript evaluation, DOM
automation, file create/rename/delete, WebLLM, embeddings, or a persistent
conversation/index.

The Agent UI loads on the first panel open; AI SDK Core's `ToolLoopAgent` and the
OpenAI provider load on the first run. Production validation keeps the model
runtime outside the launcher bundle and optional offline precache. OpenAI
inference always requires network access.

## PWA Support

The app ships `public/site.webmanifest` and `public/service-worker.js`. The
service worker is registered only for production builds, so normal
`dev:frontend` sessions do not keep stale development assets. Use
`vp run local-md-workspace#build` followed by `vp run local-md-workspace#preview`
to test installability and offline app-shell loading.

The service worker caches same-origin GET navigations and static assets. Cloud
storage requests, relay API mutations, and relay WebSockets remain network-only.
The initial app shell does not execute or compile Loro, AI SDK, or the OpenAI
provider. Collaboration code and its WASM runtime load only when a workspace
file or shared-file route is opened; the Agent UI loads when its panel first
opens, and the model runtime loads only when a run starts. Production builds
inject the launcher and collaboration static closures, Loro WASM, the
Tree-sitter runtime, the Markdown block and inline
grammars, and their highlight-query dependencies into a content-keyed offline
precache. The optional Agent chunks are not part of the required offline closure.
Installation fails closed if a critical asset is unavailable.
`vp run local-md-workspace#bundle:check` verifies these boundaries and caps
bundled Tree-sitter grammars to LiveMD's focused set. Code-fence parsers are
fetched and compiled only after a supported fence alias appears in the document
and remain outside the critical offline precache.

Run `vp run local-md-workspace#smoke:agent` for the focused Chromium fake-model,
IndexedDB reopen, and page-memory credential checks. The broader
`vp run local-md-workspace#smoke:ui` includes the same Agent assertions.

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
