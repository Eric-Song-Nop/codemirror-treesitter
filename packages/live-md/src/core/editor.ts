import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { minimalSetup } from "@codemirror-treesitter/basic-setup";
import { EditorView, placeholder as placeholderExtension, type ViewUpdate } from "@codemirror/view";
import {
  cleanupPlugins,
  mountPlugins,
  normalizeLiveMdConfig,
  normalizeLiveMdMarkdownConfig,
  pluginExtensions,
  type LiveMdConfig,
  type LiveMdPlugin,
  type LiveMdPluginCleanup,
  type ResolvedLiveMdConfig,
} from "./config.js";
import { liveMarkdown } from "./extension.js";
import { liveMdMarkdownFeatures, type LiveMdMarkdownConfig } from "./features.js";
import type { LiveMdImageSourceResolver } from "./images.js";
import {
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  setCodeFenceLanguages,
} from "./languages.js";
import type { LiveMdLinkBaseUrl } from "./links.js";

export type LiveMdEditorChange = {
  update: ViewUpdate;
  value: string;
  view: EditorView;
};

export type LiveMdEditorOptions = {
  autofocus?: boolean;
  config?: LiveMdConfig;
  defaultValue?: string;
  doc?: string;
  extensions?: Extension;
  focus?: boolean;
  imageSource?: LiveMdImageSourceResolver | null;
  linkBaseUrl?: LiveMdLinkBaseUrl | null;
  markdown?: LiveMdMarkdownConfig;
  onBlur?: (view: EditorView) => void;
  onChange?: (change: LiveMdEditorChange) => void;
  parent: Element | DocumentFragment;
  persistKey?: string | null;
  placeholder?: string;
  plugins?: readonly LiveMdPlugin[];
  readOnly?: boolean;
  root?: Document | ShadowRoot;
  value?: string;
};

export type LiveMdEditorController = {
  destroy: () => void;
  ready: Promise<void>;
  setConfig: (config: LiveMdConfig) => void;
  setExtensions: (extensions: Extension) => void;
  setMarkdown: (markdown: LiveMdMarkdownConfig) => void;
  setPersistKey: (persistKey: null | string) => void;
  setPlaceholder: (placeholder: string) => void;
  setPlugins: (plugins: readonly LiveMdPlugin[]) => void;
  setReadOnly: (readOnly: boolean) => void;
  setValue: (value: string) => void;
  value: string;
  view: EditorView;
};

export type LiveMdEditorHandle = LiveMdEditorController;

export function createLiveMdEditor(options: LiveMdEditorOptions): LiveMdEditorController {
  let markdownCompartment = new Compartment();
  let extensionsCompartment = new Compartment();
  let featuresCompartment = new Compartment();
  let placeholderCompartment = new Compartment();
  let pluginsCompartment = new Compartment();
  let readOnlyCompartment = new Compartment();
  let activePluginCleanups: LiveMdPluginCleanup[] = [];
  let cancelled = false;
  let suppressChange = false;
  let liveMdConfig = normalizeLiveMdConfig(options.config, {
    markdown: options.markdown,
    plugins: options.plugins,
  });
  let persistKey = normalizePersistKey(options.persistKey);
  let view: EditorView;
  let initialValue = initialEditorValue(options, persistKey);

  view = new EditorView({
    parent: options.parent,
    root: options.root,
    state: EditorState.create({
      doc: initialValue,
      extensions: [
        liveMarkdown({ imageSource: options.imageSource, linkBaseUrl: options.linkBaseUrl }),
        featuresCompartment.of(liveMdMarkdownFeatures(liveMdConfig.markdown.features)),
        markdownCompartment.of([]),
        placeholderCompartment.of(placeholderValue(options.placeholder)),
        readOnlyCompartment.of(readOnlyExtensions(options.readOnly ?? false)),
        minimalSetup,
        pluginsCompartment.of(pluginExtensions(liveMdConfig.plugins)),
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
      cleanupPlugins(activePluginCleanups);
      activePluginCleanups = [];
      view.destroy();
    },
    ready: Promise.all([markdownReady, codeFenceReady]).then(() => undefined),
    setConfig(config) {
      reconfigureLiveMdConfig(normalizeLiveMdConfig(config), true);
    },
    setExtensions(extensions) {
      view.dispatch({
        effects: extensionsCompartment.reconfigure(extensions),
      });
    },
    setMarkdown(markdown) {
      reconfigureLiveMdConfig(
        {
          ...liveMdConfig,
          markdown: normalizeLiveMdMarkdownConfig(markdown),
        },
        false,
      );
    },
    setPersistKey(nextPersistKey) {
      persistKey = normalizePersistKey(nextPersistKey);
    },
    setPlaceholder(placeholder) {
      view.dispatch({
        effects: placeholderCompartment.reconfigure(placeholderValue(placeholder)),
      });
    },
    setPlugins(nextPlugins) {
      reconfigureLiveMdConfig(
        {
          ...liveMdConfig,
          plugins: nextPlugins,
        },
        true,
      );
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

  try {
    remountPlugins();
  } catch (error) {
    cleanupPlugins(activePluginCleanups);
    view.destroy();
    throw error;
  }

  return controller;

  function reconfigureLiveMdConfig(nextConfig: ResolvedLiveMdConfig, pluginsChanged: boolean) {
    liveMdConfig = nextConfig;
    let effects = [
      featuresCompartment.reconfigure(liveMdMarkdownFeatures(liveMdConfig.markdown.features)),
    ];
    if (pluginsChanged) {
      effects.push(pluginsCompartment.reconfigure(pluginExtensions(liveMdConfig.plugins)));
    }
    view.dispatch({ effects });
    remountPlugins();
  }

  function remountPlugins() {
    cleanupPlugins(activePluginCleanups);
    activePluginCleanups = mountPlugins(liveMdConfig.plugins, {
      markdown: liveMdConfig.markdown,
      parent: options.parent,
      root: pluginRoot(options),
      view,
    });
  }
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

function pluginRoot(options: Pick<LiveMdEditorOptions, "parent" | "root">): Document | ShadowRoot {
  if (options.root) return options.root;
  if (typeof Element != "undefined" && options.parent instanceof Element) {
    return options.parent.ownerDocument;
  }
  let root = options.parent.getRootNode();
  if (typeof ShadowRoot != "undefined" && root instanceof ShadowRoot) return root;
  return options.parent.ownerDocument;
}

function loadPersistedValue(storageKey: string, fallback: string) {
  let storage = browserLocalStorage();
  if (!storage) return fallback;
  try {
    let persistedValue = storage.getItem(storageKey);
    return persistedValue == null ? fallback : persistedValue;
  } catch {
    return fallback;
  }
}

function savePersistedValue(storageKey: null | string, value: string) {
  if (!storageKey) return;
  let storage = browserLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey, value);
  } catch {
    // Persistence is an optional host integration.
  }
}

function browserLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    let storage = (globalThis as typeof globalThis & { window?: { localStorage?: Storage } }).window
      ?.localStorage;
    if (storage) return storage;
  } catch {}

  let descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  if (descriptor && "value" in descriptor && descriptor.value) {
    return descriptor.value as Storage;
  }
  return null;
}
