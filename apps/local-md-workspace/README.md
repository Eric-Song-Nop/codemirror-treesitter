# local-md-workspace

React local-first Markdown workspace built around LiveMD. It opens local
folders through the browser File System Access API, edits `.md` files, manages
workspace trees, and can optionally use the experimental OpenDAL Dropbox
backend.

## Stack and Boundaries

- Uses Vite+, React 19, Tailwind CSS 4, shadcn/ui with the `radix-nova` style,
  Radix primitives, and lucide icons.
- Depends on `@codemirror-treesitter/live-md`,
  `@codemirror-treesitter/theme-gruvbox`, and the private
  `@codemirror-treesitter/opendal-wasm-browser` wrapper.
- Local folder access is browser-only and requires File System Access API
  support.
- Dropbox support uses a public OAuth PKCE flow in the app and the OpenDAL WASM
  package for storage operations. Do not put secrets in frontend environment
  variables.

## Source Layout

- `src/App.tsx`: application shell, workspace state wiring, file actions, image
  insert/drop handling, backend switching, and editor integration.
- `src/main.tsx`: React entry.
- `src/components/LiveMdEditor.tsx`: React wrapper around the LiveMD custom
  element.
- `src/components/FileTree.tsx`: Markdown tree navigation and file/directory
  actions.
- `src/components/ui/*`: shadcn/ui components.
- `src/lib/file-system.ts`: File System Access API workspace backend.
- `src/lib/dropbox-oauth.ts`, `src/lib/dropbox-workspace-backend.ts`, and
  `src/lib/dropbox-redirect-draft.ts`: Dropbox auth and OpenDAL-backed
  workspace support.
- `src/lib/workspace-backend.ts`, `workspace-store.ts`, `workspace-status.ts`,
  and `workspace-errors.ts`: shared workspace models, persistence, status, and
  error helpers.
- `smoke/ui-smoke.mjs`: Playwright-style UI smoke automation.

## Environment

Optional Dropbox configuration lives in `apps/local-md-workspace/.env.local`:

```env
VITE_DROPBOX_APP_KEY="your-public-app-key"
VITE_DROPBOX_REDIRECT_URI="http://localhost:5173"
```

`VITE_DROPBOX_REDIRECT_URI` must exactly match a Dropbox App Console redirect
URI when it is provided. The app derives the current page URL when the variable
is omitted.

## Local Commands

Run from the workspace root:

```bash
vp run local-md-workspace#dev
vp run local-md-workspace#build
vp run local-md-workspace#preview
vp run local-md-workspace#smoke:ui
```

`vp run local-md-workspace#smoke:ui` expects the dev server at
`http://127.0.0.1:5173/` by default. Set
`LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN` or `OPENDAL_DROPBOX_ACCESS_TOKEN` to
include credential-gated Dropbox smoke coverage.
