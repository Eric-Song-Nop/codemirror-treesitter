# LiveMD cursor review follow-up

Reviewed commit: `be21050a27cc3e54c12cf039c3076a46f27c3834`.

Two additional cursor-specific problems were reproduced in the pinned Loro adapter. Distinguish a stored position outside document bounds from a position that is numerically valid but points to the wrong text. Both can occur here. No production code was modified.

## 1. P2 — Remote collaborator positions are not remapped on imported edits

Locations: `node_modules/loro-codemirror/src/ephemeral.ts:40–60,189–229`. The package is used by `liveMdLoroCollaboration()` when its optional `presence` configuration is supplied.

The presence field stores numeric anchor/head offsets. Its update method processes presence effects but does not map existing offsets through document changes. The document subscription recomputes remote positions only for `e.by === "local"`; imported changes are omitted. Thus a remote cursor packet followed by another document import can leave stale offsets until another presence update arrives.

Reproduction with real Loro document imports and a valid initial presence StateEffect (the same effect used by incoming presence packets):

| Step                                      | Document length | Local caret          | Stored remote selection         |
| ----------------------------------------- | --------------- | -------------------- | ------------------------------- |
| Initial `abcdefghij`                      | 10              | 8                    | 8–9                             |
| Import insertion of `ZZ` at the beginning | 12              | 10, correctly mapped | Still 8–9; should be 10–11      |
| Import deletion leaving only `ZZ`         | 2               | 2, correctly mapped  | Still 8–9; outside the document |

The rendered remote caret is clamped by `RemoteCursorMarker.calculateAbsoluteCursorPosition()` in `awareness.ts:257–266`, so this does not establish that the visible caret is drawn outside the document. It establishes incorrect remote cursor state and wrong placement after insertion. The remote selection layer consumes the uncorrected range. A rendering exception was not reproduced or asserted.

Fix: resolve remote CRDT cursors after every relevant document change, including imports, against the same document revision as the editor. Also map/validate stored numeric ranges while updates are pending. Clamping alone cannot correct a valid-but-wrong offset after an insertion.

## 2. P2 — Delayed Loro undo restoration overwrites a newer local selection

Location: `node_modules/loro-codemirror/src/undo.ts:97–112`.

The undo callback schedules cursor restoration with an unconditional `setTimeout(..., 0)`. It neither checks that the view/selection generation is still current nor cancels restoration when a newer selection arrives.

Reproduction: start with `abcdef`, put the caret at 3, insert `X`, undo, immediately move the caret to 0, then allow the timer to run. The text correctly becomes `abcdef`, but the caret moves back to 3. The probe invokes the supplied `UndoManager` directly and dispatches the newer selection before the timer; it demonstrates the ordering race without claiming that every keyboard undo exhibits it.

This is a numerically valid but stale local caret position. Fix by restoring selection with the undo update when possible, or guarding deferred work by view lifetime and selection generation. Newer user selections must supersede pending restoration.

## Previously confirmed synchronization failures also invalidate cursor meaning

The original review's mixed-container import and multiple-views-on-one-LoroDoc bugs leave CodeMirror and Loro with different text. An offset may still be valid in CodeMirror while referring to a different character, or lying beyond the end, in Loro. Such divergence compromises cursor resolution, insertion positions, and undo metadata. Those two synchronization bugs should be fixed before attempting to hide symptoms by clamping selections.

## Standalone local editing

No standalone local out-of-bounds selection was reproduced in this follow-up. CodeMirror checks selection bounds when applying state, and the LiveMD web component normalizes public selection positions to the document length (`packages/live-md/src/element/live-md-editor.ts:396–409`). Those safeguards do not guarantee that every visually observed cursor jump is correct.

`createLiveMdEditor().setValue()` explicitly resets selection to 0 while replacing the full document (`packages/live-md/src/core/editor.ts`, `setValue`). A host calling this during editing can explain jumps to the start; the behavior is explicit, rather than a newly established parser bug.

The parser interruption and projection issues in the original review establish lost reuse and unnecessary work. They do not, by themselves, establish out-of-range caret positions.

## Validation

- Two new cursor probes reproduce the failures above.
- 79 existing local tests passed across `block-preview-boundary`, `active-source-island`, and `newline`.
- `vp check` passed with the new probe present.
- Actual browser pointer/IME interactions and network presence delivery were not exercised end to end.

The companion `livemd-cursor-reproductions.patch` adds the probes to the existing collaboration test file. Apply it in a disposable checkout and run:

```sh
vp run @codemirror-treesitter/live-md-loro#test -- tests/collaboration.test.ts -t 'CURSOR REVIEW'
```

Both tests intentionally fail on this revision.
