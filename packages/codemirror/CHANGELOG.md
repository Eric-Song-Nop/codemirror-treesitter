# @codemirror-treesitter/basic-setup

## 0.0.1

### Patch Changes

- f886726: Review fix pass. Every package now ships an MIT LICENSE with upstream
  CodeMirror attribution. `language` keeps incremental state across in-flight
  parses, scopes highlight queries to the requested range with last-pattern-wins
  precedence, shares one native parser per lineage, resumes stream parsing across
  slices, and follows Lezer `resolve` side semantics. `live-md` computes its value
  lazily, debounces persistence (`liveMdPersistDelay`, `flushPersistence()`),
  loads KaTeX and its fonts on demand, sanitizes Mermaid SVG on both render paths,
  and no longer autofocuses by default. `autocomplete` fixes two closeBrackets
  bugs; `lsp-client` reports its own clientInfo and fixes disconnect; `merge`
  re-renders the unified view after language load.

  The concrete Gruvbox, GitHub, and Catppuccin themes now ship as subpath
  entries of the shared packages instead of six separate packages:
  `@codemirror-treesitter/theme/{gruvbox,github,catppuccin}` for CodeMirror
  editor themes and `@codemirror-treesitter/live-md-theme/{gruvbox,github,catppuccin}`
  for LiveMD presentation themes.

- Updated dependencies [f886726]
  - @codemirror-treesitter/language@0.1.0
  - @codemirror-treesitter/commands@0.0.1
  - @codemirror-treesitter/autocomplete@0.0.1
