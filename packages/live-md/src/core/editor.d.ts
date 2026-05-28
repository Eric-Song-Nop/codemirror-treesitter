import { type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
export type LiveMdEditorChange = {
    update: ViewUpdate;
    value: string;
    view: EditorView;
};
export type LiveMdEditorOptions = {
    autofocus?: boolean;
    defaultValue?: string;
    doc?: string;
    extensions?: Extension;
    focus?: boolean;
    onBlur?: (view: EditorView) => void;
    onChange?: (change: LiveMdEditorChange) => void;
    parent: Element | DocumentFragment;
    persistKey?: string | null;
    placeholder?: string;
    readOnly?: boolean;
    root?: Document | ShadowRoot;
    value?: string;
};
export type LiveMdEditorController = {
    destroy: () => void;
    ready: Promise<void>;
    setExtensions: (extensions: Extension) => void;
    setPersistKey: (persistKey: null | string) => void;
    setPlaceholder: (placeholder: string) => void;
    setReadOnly: (readOnly: boolean) => void;
    setValue: (value: string) => void;
    value: string;
    view: EditorView;
};
export type LiveMdEditorHandle = LiveMdEditorController;
export declare function createLiveMdEditor(options: LiveMdEditorOptions): LiveMdEditorController;
