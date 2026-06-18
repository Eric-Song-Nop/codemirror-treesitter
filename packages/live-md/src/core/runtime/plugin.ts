import { RangeSet, type EditorState, type Extension, type RangeValue } from "@codemirror/state";
import { syntaxTree } from "@codemirror-treesitter/language";
import { EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  activeLiveMdLines,
  createLiveMdInvalidation,
  fullLiveMdDocRange,
  sameLiveMdNumberSet,
  sameLiveMdRanges,
  type LiveMdDocRange,
  type LiveMdRuntimeSnapshot,
} from "../analysis/index.js";
import {
  readLiveMdRuntimeConfig,
  sameLiveMdRuntimeConfig,
  type LiveMdRuntimeConfig,
} from "./config.js";
import { createLiveMdRuntimeSnapshot } from "./snapshot.js";
import { visibleLiveMdLineRanges } from "./viewport.js";

export class LiveMdRuntimePlugin {
  private config: LiveMdRuntimeConfig;
  snapshot: LiveMdRuntimeSnapshot;

  constructor(readonly view: EditorView) {
    this.config = readLiveMdRuntimeConfig(view.state);
    this.snapshot = createLiveMdRuntimeSnapshot(view.state, {
      activeLines: activeLiveMdLines(view.state),
      config: this.config,
      visibleRanges: visibleLiveMdLineRanges(view),
    });
  }

  update(update: ViewUpdate) {
    let nextConfig = readLiveMdRuntimeConfig(update.state);
    let configChanged = !sameLiveMdRuntimeConfig(this.config, nextConfig);
    let nextActiveLines = activeLiveMdLines(update.state);
    let selectionChanged =
      update.selectionSet || !sameLiveMdNumberSet(this.snapshot.activeLines, nextActiveLines);
    let nextVisibleRanges = visibleLiveMdLineRanges(update.view);
    let viewportChanged =
      update.viewportChanged || !sameLiveMdRanges(this.snapshot.visibleRanges, nextVisibleRanges);
    let nextTree = syntaxTree(update.state);
    let treeChanged = nextTree != this.snapshot.tree;

    if (
      !update.docChanged &&
      !treeChanged &&
      !configChanged &&
      !selectionChanged &&
      !viewportChanged
    ) {
      return;
    }

    let invalidation = createLiveMdInvalidation({
      activeLines: nextActiveLines,
      configChanged,
      previousActiveLines: this.snapshot.activeLines,
      previousIndex: this.snapshot.semanticIndex,
      selectionChanged,
      startState: update.startState,
      state: update.state,
      transactions: update.transactions,
      treeChanged,
      viewportChanged,
      visibleRanges: nextVisibleRanges,
    });

    this.config = nextConfig;
    this.snapshot = createLiveMdRuntimeSnapshot(update.state, {
      activeLines: nextActiveLines,
      config: nextConfig,
      invalidation,
      previous: this.snapshot,
      visibleRanges: nextVisibleRanges,
    });
  }

  get atomicRanges(): RangeSet<RangeValue> {
    return this.snapshot.atomicRanges;
  }

  get decorations(): DecorationSet {
    return this.snapshot.decorations;
  }
}

export const liveMdRuntimePlugin = ViewPlugin.fromClass(LiveMdRuntimePlugin, {
  decorations: (plugin) => plugin.decorations,
  provide: (plugin) =>
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomicRanges ?? RangeSet.empty),
});

export const liveMdAnalysis: Extension = liveMdRuntimePlugin;

export function __testBuildLiveMdAnalysis(state: EditorState) {
  return createLiveMdRuntimeSnapshot(state, {
    activeLines: activeLiveMdLines(state),
    config: readLiveMdRuntimeConfig(state),
    visibleRanges: fullLiveMdDocRange(state),
  });
}

export function __testBuildVisibleLiveMdAnalysis(
  state: EditorState,
  ranges: readonly LiveMdDocRange[],
) {
  return createLiveMdRuntimeSnapshot(state, {
    activeLines: activeLiveMdLines(state),
    config: readLiveMdRuntimeConfig(state),
    visibleRanges: ranges,
  });
}

export function __testLiveMdAnalysis(view: EditorView): LiveMdRuntimeSnapshot {
  let plugin = liveMdPluginFromView(view);
  if (plugin) return plugin.snapshot;
  return __testBuildLiveMdAnalysis(view.state);
}

function liveMdPluginFromView(view: EditorView) {
  let maybeView = view as EditorView & {
    plugin?: EditorView["plugin"];
  };
  return maybeView.plugin?.(liveMdRuntimePlugin) ?? null;
}
