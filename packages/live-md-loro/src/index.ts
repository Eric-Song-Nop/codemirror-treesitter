import { EditorState, Transaction, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { LiveMdPlugin } from "@codemirror-treesitter/live-md";
import { LoroExtensions, redo as loroRedo, undo as loroUndo } from "loro-codemirror";
import { loroSyncAnnotation } from "loro-codemirror/sync";
import type { EphemeralStore, LoroDoc, LoroText, UndoManager, Value } from "loro-crdt";

const liveMdExternalEditOrigin = "live-md:external-edit";

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
  let getTextFromDoc = createCollaborationLoroTextGetter(options.text);
  return [
    markLoroSyncTransactionsRemote(),
    LoroExtensions(options.doc, options.presence, options.undoManager, getTextFromDoc),
  ];
}

export function commitLiveMdLoroExternalEdit(doc: LoroDoc) {
  doc.commit({ origin: liveMdExternalEditOrigin });
}

export function liveMdLoroCollaborationPlugin(
  options: LiveMdLoroCollaborationOptions,
): LiveMdPlugin {
  return {
    extension: liveMdLoroCollaboration(options),
  };
}

export function createLiveMdLoroTextGetter(text: LiveMdLoroTextSource = "markdown") {
  if (typeof text == "function") return text;
  return (doc: LoroDoc) => doc.getText(text);
}

function createCollaborationLoroTextGetter(text: LiveMdLoroTextSource = "markdown") {
  if (typeof text == "function") return text;

  return (doc: LoroDoc) => {
    let ownedText = doc.getText(text);
    // loro-codemirror consumes every getter result synchronously, but requests a fresh
    // handle for each read or edit. Release our string-key handles after that stack ends.
    queueMicrotask(() => ownedText.free());
    return ownedText;
  };
}

export function getLiveMdLoroText(doc: LoroDoc, text: LiveMdLoroTextSource = "markdown"): LoroText {
  return createLiveMdLoroTextGetter(text)(doc);
}

function markLoroSyncTransactionsRemote(): Extension {
  return EditorState.transactionExtender.of((transaction) => {
    if (
      !transaction.docChanged ||
      transaction.annotation(Transaction.remote) === true ||
      !transactionHasLoroSyncAnnotation(transaction)
    ) {
      return null;
    }
    return { annotations: Transaction.remote.of(true) };
  });
}

function transactionHasLoroSyncAnnotation(transaction: Transaction) {
  return transaction.annotation(loroSyncAnnotation) != null;
}

export const liveMdLoroUndo: (view: EditorView) => boolean = loroUndo;
export const liveMdLoroRedo: (view: EditorView) => boolean = loroRedo;
