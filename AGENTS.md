<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp run -r test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Project Notes for Agents

## Stack Snapshot

- Runtime/package management: Bun `1.3.14` through Vite+ `vp install`; Node.js
  `>=26.0.0`.
- Workspace tooling: Vite+ (`vp`) for dev, build, pack, check, test, preview,
  formatting, linting, type checking, task caching, and script orchestration.
- Language: TypeScript 6.x, ES modules, shared `tsconfig.*` files, and package
  builds through `vp pack`.
- Editor base: official `@codemirror/state`, `@codemirror/view`,
  `@codemirror/search`, and `@codemirror/lint` are allowed where they do not
  bring in Lezer-specific language behavior.
- Parser/runtime layer: `web-tree-sitter`, Tree-sitter grammar packages, WASM
  assets, highlight queries, and local CodeMirror-compatible wrappers. The root
  override currently resolves `web-tree-sitter` to `vendor/web-tree-sitter` for
  a local cursor range navigation binding patch.
- Product/runtime integrations: LiveMD uses KaTeX, Mermaid, and
  `beautiful-mermaid`; optional collaboration uses `loro-crdt` and
  `loro-codemirror`; `apps/local-md-workspace` uses React 19, shadcn/radix UI,
  Zustand for its authoritative application read model, Effect for typed async
  orchestration and scoped resource lifecycles, i18next/react-i18next, the
  browser File System Access API, Dropbox OAuth PKCE, the OpenDAL browser WASM
  wrapper, Grove shared-file relay clients, and a lazy Vercel AI SDK
  `@ai-sdk/deepseek` browser Agent with user-provided credentials, a fixed
  `https://api.deepseek.com` origin,
  `deepseek-v4-flash` by default, and only `deepseek-v4-pro` as a manual model
  choice;
  `apps/grove-relay` and `apps/collab-editor` use Cloudflare Workers, Durable
  Objects, WebSockets, Wrangler, and `@cloudflare/vite-plugin`.

## Repository Layout

- `packages/language`: Tree-sitter parser integration, syntax-tree wrappers,
  highlighting, indentation, folding, bracket matching, bidi isolation, and
  stream-parser compatibility.
- `packages/language-data`: `LanguageDescription` registry, Tree-sitter WASM
  asset loading, highlight-query loading, language metadata, and mixed-language
  parser wiring.
- `packages/commands`: Lezer-free editing commands, comments, history, and
  keymaps.
- `packages/autocomplete`: Completion state, sources, filtering, tooltips,
  snippets, word completion, and close brackets.
- `packages/codemirror`: `@codemirror-treesitter/basic-setup`, including
  `basicSetup`, `minimalSetup`, and the compatibility `EditorView` export.
- `packages/theme-palettes`: Shared concrete palettes reused by CodeMirror
  editor themes and LiveMD presentation themes.
- `packages/theme`: Shared semantic theme token contracts and CodeMirror
  editor/highlight extension factories for concrete theme packages.
- `packages/theme-gruvbox`: Local Gruvbox editor themes and highlight styles.
- `packages/theme-github`: Local GitHub editor themes and highlight styles.
- `packages/theme-catppuccin`: Local Catppuccin editor themes and highlight
  styles.
- `packages/merge`: Diff, split merge view, unified merge view, chunk helpers,
  and local highlighting for deletion widgets.
- `packages/lsp-client`: LSP transport, plugin, workspace mapping,
  diagnostics, completions, hover, formatting, rename, definition, references,
  and signature help.
- `packages/live-md`: Live Markdown editor runtime, web component, registration
  entry, CSS export, and fixtures.
- `packages/live-md-theme`: Shared LiveMD presentation token contract and host
  variable helpers.
- `packages/live-md-theme-gruvbox`: Gruvbox LiveMD presentation themes.
- `packages/live-md-theme-github`: GitHub Light LiveMD presentation theme.
- `packages/live-md-theme-catppuccin`: Catppuccin LiveMD presentation themes.
- `packages/live-md-loro`: Optional Loro collaboration bindings for LiveMD.
- `packages/opendal-wasm-browser`: Experimental browser WASM wrapper for
  OpenDAL-backed cloud workspace storage.
- `vendor/web-tree-sitter`: Vendored `web-tree-sitter` runtime package used by
  the root override while the local cursor range navigation binding patch is
  needed.
- `apps/basic-editor`: Minimal `<live-md-editor>` smoke app.
- `apps/local-md-workspace`: Grove React shadcn/radix local-first Markdown
  workspace using LiveMD, the browser File System Access API, optional Dropbox
  storage through OpenDAL WASM, local image asset handling, a browser-resident
  DeepSeek BYOK Agent, and optional Grove shared-file collaboration through
  `apps/grove-relay`.
- `apps/grove-relay`: Grove shared-file relay Worker with Durable Object
  persistence, WebSocket Loro sync, share lifecycle APIs, and Wrangler deploy
  config.
- `apps/examples`: Side-by-side local-vs-official CodeMirror comparison app.
- `apps/live-md-benchmark`: LiveMD benchmark harness.
- `apps/live-md-loro-demo`: Local two-peer Loro collaboration demo.
- `apps/collab-editor`: Cloudflare collaboration app with Durable Object room
  persistence, WebSocket Loro sync, and standalone share lifecycle APIs.
- `tools/audit.mjs`: Network-aware parity and boundary audit for packages,
  language-data coverage, examples, benchmark wiring, and Lezer-free rules.

## Dependency Boundaries

- Effect and Zustand are application-only dependencies of
  `apps/local-md-workspace`. Do not import either library from `packages/*`
  (including LiveMD), another app, or reusable editor/runtime packages. The
  root `effect` devDependency exists only to expose the pinned source and agent
  guidance in `node_modules`; it is not a runtime dependency boundary escape.
- Implementation packages should not depend on Lezer packages or official
  language-layer CodeMirror packages unless the specific package README and
  `tools/audit.mjs` allow it.
- `apps/examples` is the comparison app and may depend on official
  CodeMirror/Lezer packages.
- Prefer imports through workspace package names and the aliases in
  `vite.shared.ts` instead of reaching across package internals from another
  package.
- CodeMirror theme packages must not import LiveMD. LiveMD presentation themes
  live in `packages/live-md-theme*`; both theme families may reuse
  `packages/theme-palettes`.
- Keep Loro collaboration optional. Do not import `loro-crdt` or
  `loro-codemirror` from `packages/live-md`.
- Grove shared-file relay APIs belong in `apps/grove-relay`; the
  `apps/collab-editor` Cloudflare app remains a separate collaboration demo.
  Package code should remain browser/library oriented.
- Dropbox workspace access belongs in `apps/local-md-workspace` and
  `packages/opendal-wasm-browser`. Do not put Dropbox OAuth, relay hosting, or
  File System Access API assumptions into core editor packages.
- Browser Agent code and AI SDK dependencies belong in
  `apps/local-md-workspace`. Keep the SDK behind its dynamic runtime adapter;
  do not add model-provider assumptions or credentials to editor packages.
- Agent credentials remain in page memory unless an explicit Agent Settings
  save writes a versioned AES-GCM ciphertext record to the dedicated
  `grove-agent-credentials` IndexedDB database. Store only ciphertext and its
  non-secret version, algorithm, KDF, random salt, and IV metadata.
- Derive the AES-GCM key locally from a vault passphrase with
  PBKDF2-HMAC-SHA256, exactly 600,000 iterations, and a random salt. Never
  persist the passphrase or derived key; every new or reloaded page starts
  locked.
- The API key, vault passphrase, and derived key must not enter React or Zustand
  state, be refilled into the DOM, or enter `localStorage`, `sessionStorage`,
  URLs, logs, telemetry, CacheStorage, or the service worker. If Web Crypto or
  IndexedDB is unavailable or an operation fails, fail closed without plaintext
  fallback. Lock and delete must stop all runs and clear page-memory secrets;
  delete must remove the record or remain locked and warn that it may remain.
- Cross-tab changes use BroadcastChannel and a `storage`-event fallback that
  writes only an opaque random revision token at
  `grove-agent-credentials:revision`. It must contain no credential or unlock
  capability; receiving it locks the tab and stops its runs.
- The vault protects saved credentials only at rest, not from same-origin XSS,
  browser extensions, a compromised profile, or code running after unlock. Fix
  the provider origin to `https://api.deepseek.com`, default to
  `deepseek-v4-flash`, and allow only `deepseek-v4-pro` as an alternative.
- DeepSeek's
  [disk context cache](https://api-docs.deepseek.com/guides/kv_cache/) is
  enabled by default and has no documented client-side opt-out. Treat request
  prefixes as remotely cached data even though conversation state stays out of
  browser storage and any locally saved credential is encrypted. DeepSeek
  documents per-user cache isolation and cleanup of unused entries, typically
  within a few hours to days.
- Agent reads and writes are current-workspace Markdown only. Resolve every
  content path through `WorkspaceRuntime.documents.document(path)` and apply
  exact edits to that shared Loro document; do not dispatch through a selected
  CodeMirror view, mutate storage, or create a second persistent Loro peer as
  an Agent shortcut.
- `packages/opendal-wasm-browser` is private and experimental. Its generated
  `pkg/` output must be rebuilt with the package WASM task when Rust wrapper
  code changes.

## Learning more about Effect

This repository uses the Effect Typescript library only in
`apps/local-md-workspace`.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the
guide does not cover, search through the source code in
`node_modules/effect/src`.

## Common Commands

Run from the workspace root unless a package-local check is intentional.

```bash
vp install
vp check
vp run -r test
vp run -r build
vp run audit
vp run ready
```

Useful task selectors:

```bash
vp run @codemirror-treesitter/language#test
vp run @codemirror-treesitter/live-md#build
vp run local-md-workspace#dev
vp run local-md-workspace#bundle:check
vp run local-md-workspace#i18n:check
vp run local-md-workspace#test
vp run local-md-workspace#smoke:agent
vp run local-md-workspace#smoke:ui
vp run grove-relay#dev
vp run grove-relay#test
vp run grove-relay#types
vp run examples#dev
vp run live-md-benchmark#benchmark
vp run live-md-loro-demo#dev
vp run collab-editor#dev
vp run collab-editor#test
vp run collab-editor#types
```

`vp run` with no task lists every task in the workspace.

## Documentation Expectations

- Update the root `README.md` when package topology, apps, toolchain,
  validation workflow, or LiveMD public API changes.
- Update package READMEs when public exports, source layout, dependencies,
  package responsibilities, tests, or dependency boundaries change.
- Update app READMEs when routes, commands, environment variables, deployment
  config, storage backends, collaboration flows, or smoke validation changes.
- Update this file when agent-facing setup, validation, dependency boundaries,
  or app/task workflows change.
- Keep docs in sync with `package.json`, `vite.config.ts`, `vite.shared.ts`,
  package `src/index.ts` files, and `tools/audit.mjs`.
