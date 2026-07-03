import { EditorState, StateEffect, Transaction, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { LiveMdPlugin } from "@codemirror-treesitter/live-md";
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

const drainLoroInitGuard = StateEffect.define<void>();

export function liveMdLoroCollaboration(options: LiveMdLoroCollaborationOptions): Extension {
  let getTextFromDoc = createLiveMdLoroTextGetter(options.text);
  return [
    markLoroSyncTransactionsRemote(),
    LoroExtensions(options.doc, options.presence, options.undoManager, getTextFromDoc),
    drainMatchingInitialLoroDispatch(options.doc, getTextFromDoc),
  ];
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
  return (
    transaction as Transaction & {
      annotations?: readonly { value: unknown }[];
    }
  ).annotations?.some((annotation) => isLoroSyncAnnotationValue(annotation.value));
}

function isLoroSyncAnnotationValue(value: unknown) {
  if (value == "undo") return true;
  return (
    typeof value == "object" &&
    value != null &&
    (value as { constructor?: { name?: string } }).constructor?.name == "LoroSyncPluginValue"
  );
}

function drainMatchingInitialLoroDispatch(
  doc: LoroDoc,
  getTextFromDoc: (doc: LoroDoc) => LoroText,
): Extension {
  return ViewPlugin.define((view) => {
    let destroyed = false;

    queueMicrotask(() => {
      if (destroyed) return;
      if (view.state.doc.toString() != getTextFromDoc(doc).toString()) return;
      // Clear loro-codemirror's armed init guard when no initial replacement was needed.
      view.dispatch({ effects: drainLoroInitGuard.of() });
    });

    return {
      destroy() {
        destroyed = true;
      },
    };
  });
}

export const liveMdLoroUndo: (view: EditorView) => boolean = loroUndo;
export const liveMdLoroRedo: (view: EditorView) => boolean = loroRedo;
