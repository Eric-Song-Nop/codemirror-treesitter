import type { AnnotationType } from "@codemirror/state";
import type { EditorView, PluginValue, ViewUpdate } from "@codemirror/view";
import type { LoroDoc, LoroText } from "loro-crdt";

export const loroSyncAnnotation: AnnotationType<unknown>;

export class LoroSyncPluginValue implements PluginValue {
  constructor(view: EditorView, doc: LoroDoc, getTextFromDoc: (doc: LoroDoc) => LoroText);
  update(update: ViewUpdate): void;
  destroy(): void;
}
