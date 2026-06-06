import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { EphemeralStore, LoroDoc, LoroText, UndoManager, Value } from "loro-crdt";

export type LoroCodemirrorPresence = {
  ephemeral: EphemeralStore;
  user: {
    name: string;
    colorClassName: string;
    [key: string]: Value;
  };
};

export function LoroExtensions(
  doc: LoroDoc,
  presence?: LoroCodemirrorPresence,
  undoManager?: UndoManager,
  getText?: (doc: LoroDoc) => LoroText,
): Extension;

export function undo(view: EditorView): boolean;

export function redo(view: EditorView): boolean;
