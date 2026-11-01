import { EditorState, StateEffect, Transaction, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { LiveMdPlugin } from "@codemirror-treesitter/live-md";
import {
  LoroEphemeralPlugin,
  LoroUndoPlugin,
  redo as loroRedo,
  undo as loroUndo,
} from "loro-codemirror";
import { LoroSyncPluginValue, loroSyncAnnotation } from "loro-codemirror/sync";
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
  let { doc, presence, undoManager } = options;
  return [
    markLoroSyncTransactionsRemote(),
    // Mirrors loro-codemirror's LoroExtensions(), with the sync plugin wrapped so
    // its init guard is drained independently of extension ordering.
    loroSyncWithDrainedInitGuard(doc, getTextFromDoc),
    undoManager ? LoroUndoPlugin(doc, undoManager, getTextFromDoc) : [],
    presence ? LoroEphemeralPlugin(doc, presence.ephemeral, presence.user, getTextFromDoc) : [],
    syncExternalLocalLoroEdits(doc, getTextFromDoc),
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

/**
 * loro-codemirror's sync plugin arms an `isInitDispatch` guard in a microtask
 * queued by its constructor and only clears it on the next view update. When the
 * editor and Loro texts already match it never dispatches, so the guard would
 * swallow the user's first edit. The wrapper constructs the sync plugin itself
 * and queues its drain microtask afterwards, so the drain always runs after the
 * guard is armed, no matter where this extension sits among other extensions.
 */
function loroSyncWithDrainedInitGuard(
  doc: LoroDoc,
  getTextFromDoc: (doc: LoroDoc) => LoroText,
): Extension {
  return ViewPlugin.define((view) => new DrainedLoroSyncPluginValue(view, doc, getTextFromDoc));
}

class DrainedLoroSyncPluginValue implements PluginValue {
  private destroyed = false;
  private sync: LoroSyncPluginValue;

  constructor(view: EditorView, doc: LoroDoc, getTextFromDoc: (doc: LoroDoc) => LoroText) {
    this.sync = new LoroSyncPluginValue(view, doc, getTextFromDoc);
    // FIFO microtask order guarantees this runs after the sync plugin's init task.
    queueMicrotask(() => {
      if (this.destroyed) return;
      // A differing text means the init replacement was dispatched and consumed the guard.
      if (view.state.doc.toString() != getTextFromDoc(doc).toString()) return;
      view.dispatch({ effects: drainLoroInitGuard.of() });
    });
  }

  update(update: ViewUpdate) {
    this.sync.update(update);
  }

  destroy() {
    this.destroyed = true;
    this.sync.destroy();
  }
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
