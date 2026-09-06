import { Annotation, type ChangeSpec } from "@codemirror/state";
import { EditorView, type PluginValue, ViewUpdate } from "@codemirror/view";
import {
    LoroDoc,
    type LoroEventBatch,
    LoroText,
    type Subscription,
} from "loro-crdt";

export const loroSyncAnnotation = Annotation.define();
let nextSyncOrigin = 0;

export class LoroSyncPluginValue implements PluginValue {
    sub?: Subscription;
    private destroyed = false;
    private readonly origin = `loro-codemirror:${nextSyncOrigin++}`;
    constructor(
        private view: EditorView,
        private doc: LoroDoc,
        private getTextFromDoc: (doc: LoroDoc) => LoroText
    ) {
        this.sub = doc.subscribe(this.onRemoteUpdate);
        Promise.resolve().then(() => {
            if (this.destroyed) return;
            const currentText = this.view.state.doc.toString();
            const text = this.getTextFromDoc(this.doc);
            if (currentText === text.toString()) {
                return;
            }
            view.dispatch({
                changes: [
                    {
                        from: 0,
                        to: this.view.state.doc.length,
                        insert: text.toString(),
                    },
                ],
                annotations: [loroSyncAnnotation.of(this)],
            });
        });
    }

    onRemoteUpdate = (e: LoroEventBatch) => {
        if (e.by === "local" && e.origin === this.origin) {
            return;
        }
        if (e.by === "checkout") {
            // TODO: better handle checkout
            this.view.dispatch({
                changes: [
                    {
                        from: 0,
                        to: this.view.state.doc.length,
                        insert: this.getTextFromDoc(this.doc).toString(),
                    },
                ],
                annotations: [loroSyncAnnotation.of(this)],
            });
            return;
        }
        if (e.by === "import" || e.by === "local") {
            for (let { diff, target } of e.events) {
                const text = this.getTextFromDoc(this.doc);
                // Skip if the event is not a text event
                if (diff.type !== "text") continue;
                // Skip if the event is not for the current document
                if (target !== text.id) continue;
                let changes: ChangeSpec[] = [];
                let pos = 0;
                const textDiff = diff.diff;
                for (const delta of textDiff) {
                    if (delta.insert) {
                        changes.push({
                            from: pos,
                            to: pos,
                            insert: delta.insert,
                        });
                    } else if (delta.delete) {
                        changes.push({
                            from: pos,
                            to: pos + delta.delete,
                        });
                        pos += delta.delete;
                    } else if (delta.retain != null) {
                        pos += delta.retain;
                    }
                }
                this.view.dispatch({
                    changes,
                    annotations: [loroSyncAnnotation.of(this)],
                });
            }
        }
    };

    update(update: ViewUpdate): void {
        if (
            !update.docChanged ||
            update.transactions.some((transaction) =>
                transaction.annotation(loroSyncAnnotation) != null)
        ) {
            return;
        }
        let adj = 0;
        update.changes.iterChanges((fromA, toA, fromB, toB, insert) => {
            const insertText = insert.sliceString(0, insert.length, "\n");
            if (fromA !== toA) {
                this.getTextFromDoc(this.doc).delete(fromA + adj, toA - fromA);
            }
            if (insertText.length > 0) {
                this.getTextFromDoc(this.doc).insert(fromA + adj, insertText);
            }
            adj += insertText.length - (toA - fromA);
        });
        this.doc.commit({ origin: this.origin });
    }

    destroy(): void {
        this.destroyed = true;
        this.sub?.();
        this.sub = undefined;
    }
}
