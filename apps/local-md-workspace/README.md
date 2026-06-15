# local-md-workspace

Grove local-first Markdown workspace. It is a React app built around LiveMD,
the browser File System Access API, optional Dropbox storage through the
OpenDAL WASM wrapper, shared OpenDAL cloud-backend foundations for OneDrive and
Google Drive, and optional shared-file collaboration through `apps/grove-relay`.

## Responsibilities

- Open a browser-granted local directory and edit `.md` files with LiveMD.
- Restore previously granted local handles when browser permissions allow it.
- Connect to Dropbox with OAuth PKCE and use
  `@codemirror-treesitter/opendal-wasm-browser` for browser-side file
  operations.
- Provide a reusable OpenDAL workspace backend for Dropbox, OneDrive, and Google Drive,
  including cloud-save serialization, token refresh retry, metadata tracking,
  and ETag-based conditional writes when supported by the provider.
- Build a Markdown file tree, create/rename/delete files and folders, autosave
  edits, and surface permission/storage errors.
- Open a command palette with `Cmd/Ctrl+Shift+P` for file navigation and core
  workspace actions.
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
- Switch the full workspace, shared-file route, LiveMD editor chrome, nested
  code highlighting, and file tree between named Gruvbox, GitHub Light, and
  Catppuccin themes.
- Install as a PWA with an app manifest and production service worker for the
  app shell, icons, and same-origin static assets.

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
- `src/lib/file-system.ts`: File System Access API backend.
- `src/lib/dropbox-oauth.ts` and `src/lib/dropbox-workspace-backend.ts`:
  Dropbox OAuth PKCE and Dropbox workspace adapter.
- `src/lib/opendal-workspace-backend.ts`,
  `src/lib/onedrive-workspace-backend.ts`, and
  `src/lib/google-drive-workspace-backend.ts`: shared OpenDAL workspace backend
  plus OneDrive and Google Drive adapter foundations. OneDrive and Google Drive
  OAuth/UI entries are not wired yet.
- `src/lib/workspace-backend.ts`: normalized workspace tree, path, image, and
  backend contracts.
- `src/lib/export/markdown-html.ts`: standalone HTML export wrapper, LiveMD
  theme snapshotting, and workspace image embedding.
- `src/lib/export/browser-print.ts`: browser print-view helper for standalone
  Markdown HTML.
- `src/lib/collaboration/*`: local Loro document persistence, share identity,
  relay protocol/client/connection, share storage, and document sync helpers.
- `src/components/ui/*`: local shadcn/radix UI primitives.
- `scripts/dev.mjs`: starts the local Grove relay when needed, then starts the
  frontend with `VITE_LOCAL_MD_SHARE_RELAY_ORIGIN`.
- `smoke/ui-smoke.mjs`: headless Chrome UI smoke for local, sharing, conflict,
  and Dropbox UI flows.

## Configuration

Optional Dropbox configuration:

```env
VITE_DROPBOX_APP_KEY="your-public-dropbox-app-key"
VITE_DROPBOX_REDIRECT_URI="http://localhost:5173"
```

Optional relay configuration:

```env
VITE_LOCAL_MD_SHARE_RELAY_ORIGIN="http://127.0.0.1:8787"
```

If the relay origin is local, `vp run local-md-workspace#dev` starts
`apps/grove-relay` automatically unless an existing relay responds at
`/__debug`.

## PWA Support

The app ships `public/site.webmanifest` and `public/service-worker.js`. The
service worker is registered only for production builds, so normal
`dev:frontend` sessions do not keep stale development assets. Use
`vp run local-md-workspace#build` followed by `vp run local-md-workspace#preview`
to test installability and offline app-shell loading.

The service worker caches same-origin GET navigations and static assets. Cloud
storage requests, relay API mutations, and relay WebSockets remain network-only.

## Commands

Run from the workspace root:

```bash
vp run local-md-workspace#dev
vp run local-md-workspace#dev:frontend
vp run local-md-workspace#build
vp run local-md-workspace#i18n:check
vp run local-md-workspace#test
vp run local-md-workspace#preview
vp run local-md-workspace#smoke:ui
```

The UI smoke requires a Chromium/Chrome binary. Set `CHROME_PATH` if it is not
discoverable. Real Dropbox storage checks additionally require
`LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN` or `OPENDAL_DROPBOX_ACCESS_TOKEN`.
