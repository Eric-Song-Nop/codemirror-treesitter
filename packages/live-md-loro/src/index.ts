import { EditorState, StateEffect, Transaction, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { LiveMdPlugin } from "@codemirror-treesitter/live-md";
import { LoroExtensions, redo as loroRedo, undo as loroUndo } from "loro-codemirror";
import { loroSyncAnnotation } from "loro-codemirror/sync";
import type {
  EphemeralStore,
  LoroDoc,
  LoroEventBatch,
  LoroText,
  UndoManager,
  Value,
} from "loro-crdt";

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

const drainLoroInitGuard = StateEffect.define<void>();

export function liveMdLoroCollaboration(options: LiveMdLoroCollaborationOptions): Extension {
  let getTextFromDoc = createCollaborationLoroTextGetter(options.text);
  return [
    markLoroSyncTransactionsRemote(),
    LoroExtensions(options.doc, options.presence, options.undoManager, getTextFromDoc),
    syncExternalLocalLoroEdits(options.doc, getTextFromDoc),
    drainMatchingInitialLoroDispatch(options.doc, getTextFromDoc),
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

function syncExternalLocalLoroEdits(
  doc: LoroDoc,
  getTextFromDoc: (doc: LoroDoc) => LoroText,
): Extension {
  return ViewPlugin.define((view) => {
    let unsubscribe = doc.subscribe((event) => {
      if (event.by != "local" || event.origin != liveMdExternalEditOrigin) return;
      for (let changes of externalEditChanges(event, doc, getTextFromDoc)) {
        view.dispatch({
          changes,
          // loro-codemirror recognizes this sentinel as an already-synchronized
          // transaction and will not write the view projection back into Loro.
          annotations: [loroSyncAnnotation.of("undo")],
        });
      }
    });
    return { destroy: unsubscribe };
  });
}

function externalEditChanges(
  event: LoroEventBatch,
  doc: LoroDoc,
  getTextFromDoc: (doc: LoroDoc) => LoroText,
) {
  let batches: Array<Array<{ from: number; insert?: string; to: number }>> = [];
  for (let { diff, target } of event.events) {
    let text = getTextFromDoc(doc);
    if (diff.type != "text" || target != text.id) continue;

    let changes: Array<{ from: number; insert?: string; to: number }> = [];
    let position = 0;
    for (let delta of diff.diff) {
      if (delta.insert) {
        changes.push({ from: position, insert: delta.insert, to: position });
      } else if (delta.delete) {
        changes.push({ from: position, to: position + delta.delete });
        position += delta.delete;
      } else if (delta.retain != null) {
        position += delta.retain;
      }
    }
    if (changes.length) batches.push(changes);
  }
  return batches;
}

export const liveMdLoroUndo: (view: EditorView) => boolean = loroUndo;
export const liveMdLoroRedo: (view: EditorView) => boolean = loroRedo;
