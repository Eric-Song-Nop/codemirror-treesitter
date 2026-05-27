import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { minimalSetup } from "@codemirror-treesitter/basic-setup";
import { EditorView, placeholder as placeholderExtension, type ViewUpdate } from "@codemirror/view";
import { liveMarkdown } from "./extension.js";
import {
  codeFenceHighlightModule,
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  setCodeFenceLanguages,
} from "./languages.js";

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

export function createLiveMdEditor(options: LiveMdEditorOptions): LiveMdEditorController {
  let markdownCompartment = new Compartment();
  let extensionsCompartment = new Compartment();
  let placeholderCompartment = new Compartment();
  let readOnlyCompartment = new Compartment();
  let cancelled = false;
  let suppressChange = false;
  let persistKey = normalizePersistKey(options.persistKey);
  let view: EditorView;
  let initialValue = initialEditorValue(options, persistKey);

  view = new EditorView({
    parent: options.parent,
    root: options.root,
    state: EditorState.create({
      doc: initialValue,
      extensions: [
        liveMarkdown(),
        codeFenceHighlightModule,
        markdownCompartment.of([]),
        placeholderCompartment.of(placeholderValue(options.placeholder)),
        readOnlyCompartment.of(readOnlyExtensions(options.readOnly ?? false)),
        minimalSetup,
        extensionsCompartment.of(options.extensions ?? []),
        EditorView.domEventHandlers({
          blur() {
            options.onBlur?.(view);
          },
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          let value = update.state.doc.toString();
          savePersistedValue(persistKey, value);
          if (!suppressChange) {
            options.onChange?.({ update, value, view });
          }
        }),
      ],
    }),
  });

  if (options.autofocus ?? options.focus ?? true) view.focus();

  let markdownReady = loadMarkdownExtension().then((extension) => {
    if (cancelled) return;
    view.dispatch({
      effects: markdownCompartment.reconfigure(extension),
    });
  });

  let codeFenceReady = loadCodeFenceLanguages().then((languageMap) => {
    if (cancelled || !languageMap.size) return;
    view.dispatch({
      effects: setCodeFenceLanguages.of(languageMap),
    });
  });

  let controller: LiveMdEditorController = {
    destroy() {
      cancelled = true;
      view.destroy();
    },
    ready: Promise.all([markdownReady, codeFenceReady]).then(() => undefined),
    setExtensions(extensions) {
      view.dispatch({
        effects: extensionsCompartment.reconfigure(extensions),
      });
    },
    setPersistKey(nextPersistKey) {
      persistKey = normalizePersistKey(nextPersistKey);
    },
    setPlaceholder(placeholder) {
      view.dispatch({
        effects: placeholderCompartment.reconfigure(placeholderValue(placeholder)),
      });
    },
    setReadOnly(readOnly) {
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly)),
      });
    },
    setValue(value) {
      if (value == view.state.doc.toString()) return;
      suppressChange = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: value },
          selection: { anchor: 0 },
          userEvent: "setValue",
        });
      } finally {
        suppressChange = false;
      }
    },
    get value() {
      return view.state.doc.toString();
    },
    view,
  };

  return controller;
}

function initialEditorValue(options: LiveMdEditorOptions, persistKey: null | string) {
  if (options.value != null) return options.value;
  if (options.doc != null) return options.doc;
  let fallback = options.defaultValue ?? "";
  return persistKey ? loadPersistedValue(persistKey, fallback) : fallback;
}

function normalizePersistKey(persistKey: null | string | undefined) {
  return persistKey?.trim() || null;
}

function readOnlyExtensions(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

function placeholderValue(value: string | undefined): Extension {
  return value ? placeholderExtension(value) : [];
}

function loadPersistedValue(storageKey: string, fallback: string) {
  try {
    let persistedValue = globalThis.localStorage?.getItem(storageKey);
    return persistedValue == null ? fallback : persistedValue;
  } catch {
    return fallback;
  }
}

function savePersistedValue(storageKey: null | string, value: string) {
  if (!storageKey) return;
  try {
    globalThis.localStorage?.setItem(storageKey, value);
  } catch {
    // Persistence is an optional host integration.
  }
}
