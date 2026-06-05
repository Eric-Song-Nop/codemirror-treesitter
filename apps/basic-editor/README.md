# basic-editor

Minimal browser smoke app for the LiveMD web component. It imports
`@codemirror-treesitter/live-md/register`, installs the LiveMD styles, and
renders one `<live-md-editor>` instance with starter Markdown content.

## Stack and Boundaries

- Uses Vite+ through `vp dev`, `vp build`, and `vp preview`.
- Depends only on `@codemirror-treesitter/live-md`.
- Uses `liveMdRawCssPlugin()` so the package CSS export can be consumed during
  local development and app builds.
- Keeps app code intentionally small; feature work belongs in `packages/live-md`
  unless it is specific to this smoke surface.

## Source Layout

- `index.html`: Vite app shell.
- `src/main.ts`: registers the LiveMD custom element and mounts the demo
  content.
- `src/style.css`: page-level layout around the editor.
- `vite.config.ts`: Vite+ config with workspace aliases and LiveMD CSS support.

## Local Commands

Run from the workspace root:

```bash
vp run basic-editor#dev
vp run basic-editor#build
vp run basic-editor#preview
```

Use this app when you need the smallest possible browser check for the custom
element registration path.
