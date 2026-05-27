import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { LoroExtensions, redo as loroRedo, undo as loroUndo } from "loro-codemirror";
import type { EphemeralStore, LoroDoc, LoroText, UndoManager, Value } from "loro-crdt";

export type LiveMdLoroTextSource = string | ((doc: LoroDoc) => LoroText);

export type LiveMdLoroUser = {
  name: string;
  colorClassName: string;
  [key: string]: Value;
};

export type LiveMdLoroPresence = {
  ephemeral: EphemeralStore;
  user: LiveMdLoroUser;
};

export type LiveMdLoroCollaborationOptions = {
  doc: LoroDoc;
  presence?: LiveMdLoroPresence;
  text?: LiveMdLoroTextSource;
  undoManager?: UndoManager;
};

export function liveMdLoroCollaboration(options: LiveMdLoroCollaborationOptions): Extension {
  let getTextFromDoc = createLiveMdLoroTextGetter(options.text);
  return LoroExtensions(options.doc, options.presence, options.undoManager, getTextFromDoc);
}

export function createLiveMdLoroTextGetter(text: LiveMdLoroTextSource = "markdown") {
  if (typeof text == "function") return text;
  return (doc: LoroDoc) => doc.getText(text);
}

export function getLiveMdLoroText(doc: LoroDoc, text: LiveMdLoroTextSource = "markdown"): LoroText {
  return createLiveMdLoroTextGetter(text)(doc);
}

export const liveMdLoroUndo: (view: EditorView) => boolean = loroUndo;
export const liveMdLoroRedo: (view: EditorView) => boolean = loroRedo;
