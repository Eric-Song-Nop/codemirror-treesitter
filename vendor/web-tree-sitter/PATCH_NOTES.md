# Codemirror Treesitter Patch Notes

This directory vendors `web-tree-sitter` from npm package version `0.26.9`.
The workspace root `package.json` overrides `web-tree-sitter` to this package
until the cursor range navigation binding fix is available upstream.

## Why This Exists

`TreeCursor.gotoFirstChildForIndex(...)` and
`TreeCursor.gotoFirstChildForPosition(...)` should jump to the first child that
contains a target byte or point while preserving the original cursor root, so a
successful `gotoParent()` returns to the original parent node.

The upstream C API returns the found child index and uses `-1` for failure. The
web binding in `0.26.9` compiled that return value through boolean semantics
inside the wasm shim. That made child index `0` look like failure, and failure
`-1` look like success. The same wasm shim also read the target byte and point
from transfer-buffer offsets that overlap the cursor context instead of the
slots populated by the generated JavaScript wrapper.

The failure reproduces with both `tree-sitter-javascript` and the bundled
Markdown grammar, so this is a `web-tree-sitter` binding issue, not a grammar
WASM issue.

## Patch Scope

The patched wasm files are:

- `web-tree-sitter.wasm`
- `debug/web-tree-sitter.wasm`

The patch changes only the exported wasm shims for:

- `ts_tree_cursor_goto_first_child_for_index_wasm`
- `ts_tree_cursor_goto_first_child_for_position_wasm`

The shim now reads the target byte/point from the transfer-buffer slots written
by the JavaScript wrapper and reports success when the C API return value is
not `-1`.

## Rebuild Flow

Start from a clean copy of npm `web-tree-sitter@0.26.9`, then run:

```bash
node tools/patch-web-tree-sitter-cursor-range.mjs --package-root /path/to/clean/web-tree-sitter
```

The script patches the wasm code section in place and preserves existing custom
sections. It is intentionally strict about byte patterns so an upstream wasm
layout change fails loudly instead of silently producing an unknown runtime.

To patch the vendored workspace package directly, omit `--package-root`:

```bash
node tools/patch-web-tree-sitter-cursor-range.mjs
```

## Verification Gate

The root verification script replays the patch against a clean npm tarball,
checks the original package integrity, and compares the patched wasm outputs:

```bash
vp run verify:web-tree-sitter
vp run @codemirror-treesitter/language#test
```

The expected upstream package checksums are:

- npm package: `web-tree-sitter@0.26.9`
- package integrity:
  `sha512-YJwSHANl6XFgeEjB8nitgj0qZYt5gkIesJ4w2srS2wcLB4GUa4xcOkM0YaMsU6WNR53YVIkDSY7Ej4pf3IXtCA==`
- package shasum: `9e44cb876c68082a2129ee8aee20ee8b702d286b`

The expected patched wasm SHA-256 checksums are:

- `web-tree-sitter.wasm`:
  `406176f41f9602138365088fb78b65abb892277ef19023d139b1d70c13097b53`
- `debug/web-tree-sitter.wasm`:
  `fdf4e1db477e25278144b2bf667dde856ca88240223f9e5ea0c82cd52c6da635`

## Upstream Exit Plan

Keep the root `web-tree-sitter` override until upstream ships a release whose
TreeCursor range-navigation binding has the same behavior:

1. `gotoFirstChildForIndex(...)` and `gotoFirstChildForPosition(...)` return
   success for child indexes `0`, `1`, middle children, and the last child.
2. Out-of-range targets return failure.
3. A successful jump preserves parent cursor semantics, so `gotoParent()`
   returns to the original parent.
4. Gate A tests in `@codemirror-treesitter/language#test` pass without the
   vendored package.

On every dependency upgrade PR, first run `vp run verify:web-tree-sitter`. If
the clean tarball integrity or byte patterns change, treat that as a required
re-review: either update this patch and checksums deliberately, or remove the
override after Gate A passes on the upstream package.
