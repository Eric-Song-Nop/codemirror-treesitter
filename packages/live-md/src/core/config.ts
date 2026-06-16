import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { LiveMdMarkdownConfig } from "./features.js";

export type LiveMdPluginCleanup = () => void;

export type LiveMdPluginContext = {
  markdown: LiveMdMarkdownConfig;
  parent: Element | DocumentFragment;
  root: Document | ShadowRoot;
  view: EditorView;
};

export type LiveMdPlugin = {
  extension?: Extension;
  mount?: (context: LiveMdPluginContext) => LiveMdPluginCleanup | void;
  name?: string;
};

export function normalizeLiveMdMarkdownConfig(
  markdown: LiveMdMarkdownConfig | null | undefined,
): LiveMdMarkdownConfig {
  return markdown ?? {};
}

export function pluginExtensions(plugins: readonly LiveMdPlugin[]): Extension {
  return plugins.map((plugin) => plugin.extension ?? []);
}

export function mountPlugins(
  plugins: readonly LiveMdPlugin[],
  context: LiveMdPluginContext,
): LiveMdPluginCleanup[] {
  let cleanups: LiveMdPluginCleanup[] = [];
  try {
    for (let plugin of plugins) {
      let cleanup = plugin.mount?.(context);
      if (cleanup) cleanups.push(cleanup);
    }
  } catch (error) {
    cleanupPlugins(cleanups);
    throw error;
  }
  return cleanups;
}

export function cleanupPlugins(cleanups: readonly LiveMdPluginCleanup[]) {
  for (let index = cleanups.length - 1; index >= 0; index--) {
    cleanups[index]?.();
  }
}
