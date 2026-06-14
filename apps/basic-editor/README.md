# basic-editor

Minimal browser smoke app for the LiveMD web component. It keeps the app surface
small on purpose: `index.html` warms LiveMD with `prepareLiveMd()`, defines the
custom element, and mounts one `<live-md-editor>` with representative Markdown
content.

## Responsibilities

- Verify that LiveMD warmup and custom element registration work without
  framework code.
- Exercise Shadow DOM styling, autofocus, Markdown widgets, task lists, links,
  inline formatting, and fenced TypeScript highlighting in a plain Vite page.
- Provide a quick manual target when debugging custom element registration or
  CSS isolation.

## Source Layout

- `index.html`: static page, sample Markdown, LiveMD warmup, and custom element
  registration.
- `src/style.css`: page shell and host sizing for the editor element.
- `public/*`: favicon and icon assets copied by Vite.

## Commands

Run from the workspace root:

```bash
vp run basic-editor#dev
vp run basic-editor#build
vp run basic-editor#preview
```

This app has no package-local test task. Use it with `vp run ready` or the
LiveMD package tests when changing editor runtime behavior.
