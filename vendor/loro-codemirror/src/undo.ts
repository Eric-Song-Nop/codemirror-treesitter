import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { Cursor, LoroDoc, LoroText, UndoManager } from "loro-crdt";
import { loroSyncAnnotation } from "./sync.ts";

export const undoEffect = StateEffect.define();
export const redoEffect = StateEffect.define();
export const undoManagerStateField = StateField.define<UndoManager | undefined>({
    create: () => undefined,
    update: value => value,
});

// UndoManager has one callback slot. Keep it owned by the live bindings and
// route restoration to the most recently active view, including undo commands.
const owners = new WeakMap<UndoManager, Set<UndoPluginValue>>();
const activeOwner = (manager: UndoManager) => Array.from(owners.get(manager) ?? []).at(-1);

export class UndoPluginValue implements PluginValue {
    private destroyed = false;
    private selectionRevision = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private lastSelection: Uint8Array[] = [];

    constructor(
        public view: EditorView,
        public doc: LoroDoc,
        private undoManager: UndoManager,
        private getTextFromDoc: (doc: LoroDoc) => LoroText
    ) {
        let bindings = owners.get(undoManager);
        if (!bindings) {
            owners.set(undoManager, bindings = new Set());
            undoManager.setOnPop((_isUndo, value) => {
                activeOwner(undoManager)?.restore(value.cursors);
            });
            undoManager.setOnPush((isUndo) => {
                const owner = activeOwner(undoManager);
                if (!owner) return { value: null, cursors: [] };
                const cursors = (isUndo ? owner.lastSelection : owner.captureSelection()).map(bytes => Cursor.decode(bytes));
                // The manager consumes the returned handles synchronously.
                queueMicrotask(() => cursors.forEach(cursor => cursor.free()));
                return { value: null, cursors };
            });
        }
        bindings.add(this);
        queueMicrotask(() => {
            if (!this.destroyed && !this.lastSelection.length) this.lastSelection = this.captureSelection();
        });
    }

    private activate(): void {
        const bindings = owners.get(this.undoManager)!;
        bindings.delete(this);
        bindings.add(this);
    }

    private captureSelection(): Uint8Array[] {
        const selection = this.view.state.selection.main;
        const text = this.getTextFromDoc(this.doc);
        return [selection.anchor, selection.head].flatMap(position => {
            const cursor = text.getCursor(Math.min(text.length, position));
            if (!cursor) return [];
            try { return [cursor.encode()]; } finally { cursor.free(); }
        });
    }

    private restore(cursors: Cursor[]): void {
        const bytes = cursors.map(cursor => {
            try { return cursor.encode(); } finally { cursor.free(); }
        });
        if (!bytes.length) return;
        clearTimeout(this.timer);
        const revision = this.selectionRevision;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (this.destroyed || revision !== this.selectionRevision) return;
            const positions = bytes.map(encoded => {
                const cursor = Cursor.decode(encoded);
                try {
                    const position = this.doc.getCursorPos(cursor);
                    position?.update?.free();
                    return position?.offset;
                } finally { cursor.free(); }
            });
            if (positions[0] === undefined) return;
            const limit = this.view.state.doc.length;
            const selection = EditorSelection.single(
                Math.min(limit, positions[0]), Math.min(limit, positions[1] ?? positions[0])
            );
            this.view.dispatch({ selection, effects: EditorView.scrollIntoView(selection.main) });
        }, 0);
    }

    update(update: ViewUpdate): void {
        if (update.selectionSet || update.transactions.some(transaction => transaction.docChanged && transaction.annotation(loroSyncAnnotation) == null)) {
            this.selectionRevision++;
            clearTimeout(this.timer);
            this.activate();
        }
        if (update.selectionSet || update.docChanged) this.lastSelection = this.captureSelection();
        for (const transaction of update.transactions) {
            for (const effect of transaction.effects) {
                if (!effect.is(undoEffect) && !effect.is(redoEffect)) continue;
                this.activate();
                queueMicrotask(() => {
                    if (this.destroyed) return;
                    if (effect.is(undoEffect)) {
                        if (this.undoManager.canUndo()) this.undoManager.undo();
                    } else if (this.undoManager.canRedo()) this.undoManager.redo();
                });
            }
        }
    }

    destroy(): void {
        this.destroyed = true;
        clearTimeout(this.timer);
        const bindings = owners.get(this.undoManager)!;
        bindings.delete(this);
        if (!bindings.size) {
            this.undoManager.setOnPop(undefined);
            this.undoManager.setOnPush(undefined);
            owners.delete(this.undoManager);
        }
    }
}

export const undo = (view: EditorView): boolean => {
    view.dispatch({
        effects: [undoEffect.of(null)],
    });
    return true;
};

export const redo = (view: EditorView): boolean => {
    view.dispatch({
        effects: [redoEffect.of(null)],
    });
    return true;
};

export const undoKeyMap = [
    {
        key: "Mod-z",
        run: undo,
        preventDefault: true,
    },
    {
        key: "Mod-y",
        mac: "Mod-Shift-z",
        run: redo,
        preventDefault: true,
    },
    {
        key: "Mod-Shift-z",
        run: redo,
        preventDefault: true,
    },
];
