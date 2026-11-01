import { Compartment, EditorState, type Extension, type Text } from "@codemirror/state";
import {
  syntaxTree,
  syntaxTreeAvailable,
  syntaxTreeChangedRanges,
  type DocRange,
} from "@codemirror-treesitter/language";
import { minimalSetup } from "@codemirror-treesitter/basic-setup";
import { EditorView, placeholder as placeholderExtension, type ViewUpdate } from "@codemirror/view";
import {
  cleanupPlugins,
  mountPlugins,
  normalizeLiveMdConfig,
  pluginExtensions,
  type LiveMdConfig,
  type LiveMdPluginCleanup,
  type ResolvedLiveMdConfig,
} from "./config.js";
import { liveMarkdown } from "./extension.js";
import { liveMdMarkdownFeatures } from "./features.js";
import type { LiveMdImageSourceResolver } from "./images.js";
import {
  syntaxCodeFenceLanguageNames,
  codeFenceLanguagesField,
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  setCodeFenceLanguages,
} from "./languages.js";
import type { LiveMdLinkBaseUrl } from "./links.js";
import { pendingKatexLoad } from "./latex.js";
import { waitForLiveMdAnalysis } from "./runtime/field.js";

export type LiveMdEditorChange = {
  update: ViewUpdate;
  /**
   * The full document text. This is a lazy getter: the document is only
   * stringified when a listener reads it, and the result is cached per
   * document, so prefer `update.state.doc` for incremental work.
   */
  readonly value: string;
  view: EditorView;
};

export type LiveMdEditorOptions = {
  /** Focus the editor after creation. Defaults to `false`. */
  autofocus?: boolean;
  config?: LiveMdConfig;
  defaultValue?: string;
  doc?: string;
  extensions?: Extension;
  /** Alias for `autofocus`. Defaults to `false`. */
  focus?: boolean;
  imageSource?: LiveMdImageSourceResolver | null;
  linkBaseUrl?: LiveMdLinkBaseUrl | null;
  onBlur?: (view: EditorView) => void;
  onChange?: (change: LiveMdEditorChange) => void;
  parent: Element | DocumentFragment;
  /**
   * `localStorage` key for the document. Writes are debounced and flushed on
   * blur, when the page becomes hidden, and on `destroy()`.
   */
  persistKey?: string | null;
  placeholder?: string;
  readOnly?: boolean;
  root?: Document | ShadowRoot;
  value?: string;
};

export type LiveMdEditorController = {
  destroy: () => void;
  /** Write any pending debounced persistence immediately. */
  flushPersistence: () => void;
  ready: Promise<void>;
  setConfig: (config: LiveMdConfig) => void;
  setExtensions: (extensions: Extension) => void;
  setPersistKey: (persistKey: null | string) => void;
  setPlaceholder: (placeholder: string) => void;
  setReadOnly: (readOnly: boolean) => void;
  setValue: (value: string) => void;
  /** The full document text, computed on access and cached per document. */
  readonly value: string;
  view: EditorView;
};

/** Debounce window for `persistKey` writes. */
export const liveMdPersistDelay = 500;

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
  let liveMdConfig = normalizeLiveMdConfig(options.config);
  let persistKey = normalizePersistKey(options.persistKey);
  let pendingCodeFenceLanguages = new Set<string>();
  let codeFenceLoads = new Set<Promise<void>>();
  let pendingFenceDiscoveryRanges: DocRange[] = [];
  let view: EditorView;
  let initialValue = initialEditorValue(options, persistKey);
  let persistence = createPersistenceScheduler(() => view.state.doc);

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
            persistence.flush();
            options.onBlur?.(view);
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            pendingFenceDiscoveryRanges = pendingFenceDiscoveryRanges.map((range) => ({
              from: update.changes.mapPos(range.from, -1),
              to: update.changes.mapPos(range.to, 1),
            }));
            update.changes.iterChangedRanges((_fromA, _toA, from, to) => {
              pendingFenceDiscoveryRanges.push({ from, to });
            });
          }
          if (syntaxTreeAvailable(update.state)) {
            let ranges = [
              ...pendingFenceDiscoveryRanges,
              ...update.transactions.flatMap((transaction) => [
                ...syntaxTreeChangedRanges(transaction),
              ]),
            ];
            pendingFenceDiscoveryRanges = [];
            if (ranges.length)
              void loadEncounteredCodeFenceLanguages(
                syntaxCodeFenceLanguageNames(syntaxTree(update.state), update.state.doc, ranges),
              );
          }
          if (!update.docChanged) return;
          if (persistKey) persistence.schedule(persistKey);
          if (!suppressChange && options.onChange) {
            options.onChange(createEditorChange(update, view));
          }
        }),
      ],
    }),
  });

  if (options.autofocus ?? options.focus ?? false) view.focus();

  let markdownReady = loadMarkdownExtension().then((extension) => {
    if (cancelled) return;
    view.dispatch({
      effects: markdownCompartment.reconfigure(extension),
    });
  });

  let codeFenceReady = markdownReady.then(async () => {
    if (cancelled) return;
    await waitForLiveMdAnalysis(view, () => cancelled);
    if (!cancelled)
      await loadEncounteredCodeFenceLanguages(
        syntaxCodeFenceLanguageNames(syntaxTree(view.state), view.state.doc),
      );
  });

  function loadEncounteredCodeFenceLanguages(encounteredNames: Iterable<string>): Promise<void> {
    let promise = loadEncountered(encounteredNames);
    codeFenceLoads.add(promise);
    void promise.finally(() => codeFenceLoads.delete(promise));
    return promise;
  }

  async function loadEncountered(encounteredNames: Iterable<string>) {
    let current = view.state.field(codeFenceLanguagesField, false) ?? new Map();
    let names = Array.from(encounteredNames).filter(
      (name) => !current.has(name) && !pendingCodeFenceLanguages.has(name),
    );
    if (!names.length) return;
    for (let name of names) pendingCodeFenceLanguages.add(name);
    let languageMap = await loadCodeFenceLanguages(names);
    for (let name of names) pendingCodeFenceLanguages.delete(name);
    if (cancelled || !languageMap.size) return;
    let latest = view.state.field(codeFenceLanguagesField, false) ?? new Map();
    view.dispatch({
      effects: setCodeFenceLanguages.of(new Map([...latest, ...languageMap])),
    });
  }

  let controller: LiveMdEditorController = {
    destroy() {
      persistence.flush();
      cancelled = true;
      cleanupPlugins(activePluginCleanups);
      activePluginCleanups = [];
      view.destroy();
    },
    flushPersistence() {
      persistence.flush();
    },
    ready: Promise.all([markdownReady, codeFenceReady]).then(async () => {
      await Promise.all(codeFenceLoads);
      if (!cancelled) await waitForLiveMdAnalysis(view, () => cancelled);
      // Initial math triggers the lazy KaTeX load; widgets re-render when it lands.
      // A failed load leaves the source visible and is not an editor failure.
      await pendingKatexLoad()?.catch(() => {});
    }),
    setConfig(config) {
      reconfigureLiveMdConfig(normalizeLiveMdConfig(config));
    },
    setExtensions(extensions) {
      view.dispatch({
        effects: extensionsCompartment.reconfigure(extensions),
      });
    },
    setPersistKey(nextPersistKey) {
      // Pending writes belong to the key that was active when they were scheduled.
      persistence.flush();
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
      if (value.length == view.state.doc.length && value == liveMdDocString(view.state.doc)) return;
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
      return liveMdDocString(view.state.doc);
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

  function reconfigureLiveMdConfig(nextConfig: ResolvedLiveMdConfig) {
    let markdownChanged = nextConfig.markdown !== liveMdConfig.markdown;
    let pluginsChanged = nextConfig.plugins !== liveMdConfig.plugins;
    liveMdConfig = nextConfig;
    let effects = [];
    if (markdownChanged) {
      effects.push(
        featuresCompartment.reconfigure(liveMdMarkdownFeatures(nextConfig.markdown.features)),
      );
    }
    if (pluginsChanged) {
      effects.push(pluginsCompartment.reconfigure(pluginExtensions(nextConfig.plugins)));
    }
    if (effects.length) view.dispatch({ effects });
    if (pluginsChanged) remountPlugins();
  }

  function remountPlugins() {
    cleanupPlugins(activePluginCleanups);
    activePluginCleanups = mountPlugins(liveMdConfig.plugins, {
      parent: options.parent,
      root: pluginRoot(options),
      view,
    });
  }
}

const docStrings = new WeakMap<Text, string>();

/** Stringify a document once per immutable `Text` instance. */
export function liveMdDocString(doc: Text) {
  let value = docStrings.get(doc);
  if (value == null) {
    value = doc.toString();
    docStrings.set(doc, value);
  }
  return value;
}

function createEditorChange(update: ViewUpdate, view: EditorView): LiveMdEditorChange {
  return {
    update,
    get value() {
      return liveMdDocString(update.state.doc);
    },
    view,
  };
}

type PersistenceScheduler = {
  flush: () => void;
  schedule: (storageKey: string) => void;
};

function createPersistenceScheduler(currentDoc: () => Text): PersistenceScheduler {
  let pendingKey: null | string = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let listening = false;
  let ownerDocument = typeof document == "undefined" ? null : document;

  function onVisibilityChange() {
    if (ownerDocument?.visibilityState == "hidden") flush();
  }

  function setListening(next: boolean) {
    if (listening == next || !ownerDocument) return;
    listening = next;
    if (next) {
      ownerDocument.addEventListener("visibilitychange", onVisibilityChange);
      globalThis.addEventListener?.("pagehide", flush);
    } else {
      ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
      globalThis.removeEventListener?.("pagehide", flush);
    }
  }

  function flush() {
    if (timer != null) clearTimeout(timer);
    timer = null;
    setListening(false);
    let storageKey = pendingKey;
    pendingKey = null;
    if (storageKey) savePersistedValue(storageKey, liveMdDocString(currentDoc()));
  }

  return {
    flush,
    schedule(storageKey) {
      if (pendingKey != null && pendingKey != storageKey) flush();
      pendingKey = storageKey;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(flush, liveMdPersistDelay);
      setListening(true);
    },
  };
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

function savePersistedValue(storageKey: string, value: string) {
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
