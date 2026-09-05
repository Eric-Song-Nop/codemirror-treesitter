# @codemirror-treesitter/live-md-loro

Optional Loro collaboration bindings for LiveMD. This package keeps CRDT and
presence dependencies out of `@codemirror-treesitter/live-md` while exposing the
plugin and extension helpers needed to bind a LiveMD editor to a `LoroDoc`.

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
- Provide `liveMdLoroCollaborationPlugin(...)` for LiveMD's unified
  `config.plugins` API while keeping `liveMdLoroCollaboration(...)` available
  as a direct CodeMirror extension.
- Export helpers for resolving the LiveMD text container from a `LoroDoc`.
- Re-export collaboration undo and redo commands as `liveMdLoroUndo` and
  `liveMdLoroRedo`.
- Project direct local Loro edits marked by
  `commitLiveMdLoroExternalEdit(...)` into every bound editor without writing
  the resulting CodeMirror transaction back into Loro.
- Synchronize ordinary local edits across views sharing one document and skip
  unrelated containers in mixed imports, without echo commits.

## Public Entry

```ts
import {
  commitLiveMdLoroExternalEdit,
  getLiveMdLoroText,
  liveMdLoroCollaboration,
  liveMdLoroCollaborationPlugin,
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
const plugin = liveMdLoroCollaborationPlugin({
  doc,
  undoManager,
  text: "markdown",
});

const text = doc.getText("markdown");
text.insert(0, "Agent edit");
commitLiveMdLoroExternalEdit(doc);
text.free();
```

`text` may be a string key or a function that returns a `LoroText` from the
document. Prefer `liveMdLoroCollaborationPlugin(...)` when configuring LiveMD
through `LiveMdConfig`; use `liveMdLoroCollaboration(...)` when a host needs a
plain CodeMirror extension.

String keys use package-owned, short-lived `LoroText` handles. The collaboration
adapter releases each handle after `loro-codemirror` consumes it synchronously,
including when one extension value is reused by multiple editor views. A custom
getter has a different ownership contract: its returned handle remains entirely
caller-owned, may be requested repeatedly, and must stay valid while the editor
uses it. The package never calls `free()` on a custom getter result.

The exported `createLiveMdLoroTextGetter(...)` and `getLiveMdLoroText(...)`
helpers are low-level accessors rather than collaboration-owned adapters. Their
returned native `LoroText` handles are caller-owned and should be freed after
use.

Use `commitLiveMdLoroExternalEdit(...)` when an application actor edits the
bound `LoroDoc` directly rather than through CodeMirror. Every bound view applies direct local Loro diffs as remote CodeMirror
transactions without echo commits, including ordinary `doc.commit()` calls.
The helper retains the application external-edit origin. Editor-originated
commits use a per-view origin so only the originating view skips projection.

## Web Component Usage

```ts
import "@codemirror-treesitter/live-md/register";
import { liveMdLoroCollaborationPlugin } from "@codemirror-treesitter/live-md-loro";
import { LoroDoc } from "loro-crdt";

const doc = new LoroDoc();
const editor = document.createElement("live-md-editor");

editor.config = {
  plugins: [liveMdLoroCollaborationPlugin({ doc })],
};
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
`apps/local-md-workspace` also uses it for owner and guest Grove shared-file
editing.

## Current Implementation Notes

- `src/index.ts` is intentionally small: it wraps `LoroExtensions`, resolves
  the LiveMD text container, exports undo/redo, and marks synchronized
  transactions remote. The vendored binding uses an annotation for initial
  projection and cancels initialization after view destruction.
- String-key collaboration getters release every fresh native `LoroText`
  wrapper after its synchronous upstream use. Custom getter results remain
  caller-owned and are never freed by this package.
- Presence is passed through as a `loro-codemirror` ephemeral store plus user
  metadata; this package does not own any network transport.

## Validation

Run from the workspace root:

```bash
vp run @codemirror-treesitter/live-md-loro#check
vp run @codemirror-treesitter/live-md-loro#test
vp run @codemirror-treesitter/live-md-loro#build
```

The root override resolves `loro-codemirror` to `vendor/loro-codemirror`.
Its upstream provenance and local fixes are documented there. Vite source aliases
and the bundled package build both consume that same maintained source.
