# @codemirror-treesitter/live-md-loro

Optional Loro collaboration bindings for LiveMD. This package keeps CRDT and
presence dependencies out of `@codemirror-treesitter/live-md` while exposing the
extensions needed to bind a LiveMD editor to a `LoroDoc`.

## Stack and Boundaries

- Depends on `@codemirror-treesitter/live-md`, official CodeMirror state/view
  packages, `loro-crdt`, and `loro-codemirror`.
- Built as an ES module package with Vite+ `vp pack`.
- Optional by design. Consumers that do not need collaboration can install and
  bundle `@codemirror-treesitter/live-md` without Loro.
- Exports only `.` and `./package.json` from the built package.

## Responsibilities

- Provide `liveMdLoroCollaboration(...)`, a CodeMirror extension that connects
  a LiveMD editor to a Loro text container.
- Support the default `"markdown"` Loro text key or a caller-provided text key
  or getter.
- Pass optional Loro presence and undo manager configuration through to
  `loro-codemirror`.
- Export helpers for resolving the LiveMD text container from a `LoroDoc`.
- Re-export collaboration undo and redo commands as `liveMdLoroUndo` and
  `liveMdLoroRedo`.
- Drain the initial Loro dispatch guard when the editor document already
  matches the Loro document, avoiding a redundant initial replacement.

## Public Entry

```ts
import {
  getLiveMdLoroText,
  liveMdLoroCollaboration,
  liveMdLoroRedo,
  liveMdLoroUndo,
} from "@codemirror-treesitter/live-md-loro";
import { LoroDoc, UndoManager } from "loro-crdt";

const doc = new LoroDoc();
const undoManager = new UndoManager(doc, {});

const extension = liveMdLoroCollaboration({
  doc,
  undoManager,
  text: "markdown",
});
```

`text` may be a string key or a function that returns a `LoroText` from the
document.

## Web Component Usage

```ts
import "@codemirror-treesitter/live-md/register";
import { liveMdLoroCollaboration } from "@codemirror-treesitter/live-md-loro";
import { LoroDoc } from "loro-crdt";

const doc = new LoroDoc();
const editor = document.createElement("live-md-editor");

editor.extensions = [liveMdLoroCollaboration({ doc })];
document.body.append(editor);
```

## Source Layout

- `src/index.ts`: collaboration extension, Loro text helpers, types, and
  undo/redo command exports.
- `tests/collaboration.test.ts`: initial state, text selection, sync guard, and
  collaboration behavior coverage.

## Relationship to Apps

`apps/live-md-loro-demo` uses this package for an in-browser two-peer
collaboration demo. `apps/collab-editor` uses it with Cloudflare Durable
Objects and WebSockets to persist and relay Loro updates between clients.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/live-md-loro#check
vp run @codemirror-treesitter/live-md-loro#test
vp run @codemirror-treesitter/live-md-loro#build
```
