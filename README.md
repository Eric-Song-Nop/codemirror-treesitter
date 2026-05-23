# CodeMirror Tree-sitter

Tree-sitter-backed reimplementations of:

- `@codemirror-treesitter/language`
- `@codemirror-treesitter/language-data`
- `@codemirror-treesitter/basic-setup`

Local Lezer-free `@codemirror-treesitter/commands` and
`@codemirror-treesitter/autocomplete` packages provide the command, history,
bracket-closing, and keymap pieces needed by `basicSetup`. These packages use a
separate `@codemirror-treesitter/*` scope to avoid confusion or dependency
resolution conflicts with the official CodeMirror packages.

The implementation packages intentionally have no Lezer dependency.
`@codemirror-treesitter/language` wraps `web-tree-sitter`, edits the previous
tree with CodeMirror change data, and passes that edited tree back into
tree-sitter for incremental reparsing. The examples app also installs the
official CodeMirror/Lezer packages so it can render the original behavior
beside the local Tree-sitter behavior for comparison.

## Development

Use Vite+ commands from the workspace root:

```bash
vp run ready
vp run -r test
vp run -r build
```

The `apps/examples` workspace is a runtime workbench for the official
CodeMirror examples that exercise language parsing or this tree-sitter
replacement surface. Each implemented example renders two editors: the local
Tree-sitter packages and the original CodeMirror/Lezer packages. The page also
shows per-example behavior comparison rows. It intentionally skips IE11, i18n,
and examples that are fully about editor APIs outside the language/parser
layer.

## Current Parity Notes

- Tree-sitter incremental reparsing is wired through `Tree.edit(...)` plus
  passing the edited old tree to `Parser.parse(...)`.
- Mixed-language parsing uses tree-sitter `includedRanges` for configured
  nested regions, and edited old nested trees are reused across document
  changes. HTML currently nests JavaScript in `<script>` blocks and CSS in
  `<style>` blocks. Nested parser sources can also defer async parser loads
  with `ParseContext.getSkippingParser(...)`, then reparse skipped regions when
  the parser promise resolves.
- `language-data` keeps grammar WASM files and published tree-sitter highlight
  queries behind lazy dynamic imports, so `LanguageDescription.load()` only
  resolves the assets needed for the selected language.
- Parsing honors CodeMirror-style time budgets by using tree-sitter's
  `progressCallback`, allowing large parses to stop and resume.
- The syntax tree wrapper exposes tree-sitter-backed node/cursor navigation,
  status, field, descendant, and error helpers while preserving the
  CodeMirror-facing `Tree`, `SyntaxNode`, `NodeType`, and `TreeCursor` names.
- HTML-family language entries attach `NodeProp.isolate` to tag nodes so
  `bidiIsolates()` can provide the same right-to-left isolation behavior the
  official bidi example expects.
- `basicSetup` includes local Lezer-free history, default keymap, close bracket,
  completion keymap, fold, search, lint, highlighting, and selection extensions.
- `StreamLanguage.define(...)` is backed by a Lezer-free stream-parser adapter
  for legacy CodeMirror 5 style stream parsers. Tree-sitter remains the parser
  path for `language-data` entries and the example workbench.
- `language-data` currently exposes the languages backed by installed
  tree-sitter WASM grammars, including upstream entries such as Angular
  Template, APL, ASN.1, Asterisk, Brainfuck, Closure Stylesheets (GSS),
  Clojure/ClojureScript/EDN, CMake, Cobol, CoffeeScript, Common Lisp, Crystal, Cypher,
  Cython, D, Dart, diff, Dockerfile, DTD, Dylan, ECL, EBNF, Eiffel, Elm, Erlang,
  Esper, F#, FCL, Factor, Forth, Fortran, Gas, Gherkin,
  Groovy, Haskell, Haxe, HTTP, HXML, IDL, Jinja, Julia, Kotlin, LaTeX, LESS, Liquid,
  LiveScript, Lua, Markdown, Mathematica, Mbox, mIRC, Modelica, MscGen, MsGenny,
  MUMPS, Nginx, NSIS, NTriples,
  Objective-C, Objective-C++, OCaml, Octave, Oz, Pascal, Perl, PGP, Pig, PowerShell, ProtoBuf, Puppet, Q, R,
  Properties/INI, Pug, RPM Changes, RPM Spec, SAS, Sass, Scheme, SCSS, Shell, Sieve, SML, Smalltalk,
  Solr, SPARQL, Spreadsheet, SQL dialect entries, sTeX, Squirrel, Stylus, Swift,
  SystemVerilog, Tcl, Textile, TiddlyWiki, Tiki wiki, TOML, Troff, TTCN, TTCN_CFG,
  Turtle, VB.NET, VBScript, Velocity, Verilog, VHDL, Vue, Web IDL, WebAssembly, XML, XQuery, Xù,
  Yacas, YAML, and Z80 when a browser-loadable grammar package is available.
  Elixir is also included through a compatible tree-sitter grammar, and
  metadata aliases/filenames mirror upstream entries. Compact in-repo grammars
  cover upstream entries that only have legacy stream modes available upstream.
