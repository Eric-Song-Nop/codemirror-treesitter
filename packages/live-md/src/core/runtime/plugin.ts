import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror-treesitter/language";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  activeLiveMdLines,
  createLiveMdInvalidation,
  fullLiveMdDocRange,
  mapLiveMdRanges,
  sameLiveMdNumberSet,
  sameLiveMdRanges,
  type LiveMdDocRange,
  type LiveMdRuntimeSnapshot,
} from "../analysis/index.js";
import { readLiveMdRuntimeConfig, sameLiveMdRuntimeConfig } from "./config.js";
import { createLiveMdRuntimeSnapshot } from "./snapshot.js";
import { visibleLiveMdLineRanges } from "./viewport.js";

const setLiveMdViewportRanges = StateEffect.define<readonly LiveMdDocRange[]>();

export class LiveMdRuntimePlugin {
  private pendingViewportDispatch = false;
  private visibleRanges: readonly LiveMdDocRange[];

  constructor(readonly view: EditorView) {
    this.visibleRanges =
      view.state.field(liveMdRuntimeField, false)?.visibleRanges ?? visibleLiveMdLineRanges(view);
  }

  update(update: ViewUpdate) {
    if (updateHasLiveMdViewportEffect(update)) {
      this.visibleRanges =
        update.state.field(liveMdRuntimeField, false)?.visibleRanges ?? this.visibleRanges;
      return;
    }

    let nextVisibleRanges = visibleLiveMdLineRanges(update.view);
    let snapshotRanges = update.state.field(liveMdRuntimeField, false)?.visibleRanges;
    let changed =
      update.docChanged ||
      update.viewportChanged ||
      !sameLiveMdRanges(snapshotRanges ?? this.visibleRanges, nextVisibleRanges);
    this.visibleRanges = nextVisibleRanges;
    if (!changed) {
      return;
    }

    this.scheduleViewportDispatch(update.view, nextVisibleRanges);
  }

  private scheduleViewportDispatch(view: EditorView, visibleRanges: readonly LiveMdDocRange[]) {
    if (this.pendingViewportDispatch) return;
    this.pendingViewportDispatch = true;
    queueMicrotask(() => {
      this.pendingViewportDispatch = false;
      let current = view.state.field(liveMdRuntimeField, false)?.visibleRanges;
      if (current && sameLiveMdRanges(current, visibleRanges)) return;
      view.dispatch({ effects: setLiveMdViewportRanges.of(visibleRanges) });
    });
  }
}

const liveMdRuntimeField = StateField.define<LiveMdRuntimeSnapshot>({
  create(state) {
    return createLiveMdRuntimeSnapshot(state, {
      activeLines: activeLiveMdLines(state),
      config: readLiveMdRuntimeConfig(state),
      visibleRanges: fullLiveMdDocRange(state),
    });
  },
  update(snapshot, transaction) {
    let nextConfig = readLiveMdRuntimeConfig(transaction.state);
    let configChanged = !sameLiveMdRuntimeConfig(
      readLiveMdRuntimeConfig(transaction.startState),
      nextConfig,
    );
    let nextActiveLines = activeLiveMdLines(transaction.state);
    let selectionChanged =
      !!transaction.selection || !sameLiveMdNumberSet(snapshot.activeLines, nextActiveLines);
    let nextTree = syntaxTree(transaction.state);
    let treeChanged = nextTree != snapshot.tree;
    let visibleRanges = nextLiveMdVisibleRanges(snapshot, transaction);
    let viewportChanged = !sameLiveMdRanges(snapshot.visibleRanges, visibleRanges);

    if (
      !transaction.docChanged &&
      !treeChanged &&
      !configChanged &&
      !selectionChanged &&
      !viewportChanged
    ) {
      return snapshot;
    }

    let invalidation = createLiveMdInvalidation({
      activeLines: nextActiveLines,
      configChanged,
      previousActiveLines: snapshot.activeLines,
      previousIndex: snapshot.semanticIndex,
      selectionChanged,
      startState: transaction.startState,
      state: transaction.state,
      transactions: [transaction],
      treeChanged,
      visibleRanges,
    });

    return createLiveMdRuntimeSnapshot(transaction.state, {
      activeLines: nextActiveLines,
      config: nextConfig,
      invalidation,
      previous: snapshot,
      visibleRanges,
    });
  },
  provide(field) {
    return [
      EditorView.decorations.from(field, (snapshot) => snapshot.decorations),
      EditorView.atomicRanges.of(
        (view) => view.state.field(field, false)?.atomicRanges ?? RangeSet.empty,
      ),
    ];
  },
});

export const liveMdRuntimePlugin = ViewPlugin.fromClass(LiveMdRuntimePlugin, {
  provide: () => [],
});

export const liveMdAnalysis: Extension = [liveMdRuntimeField, liveMdRuntimePlugin];

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
  let fieldSnapshot = view.state.field(liveMdRuntimeField, false);
  if (fieldSnapshot) return fieldSnapshot;
  return __testBuildLiveMdAnalysis(view.state);
}

export const __testSetLiveMdViewportRanges = setLiveMdViewportRanges;

function updateHasLiveMdViewportEffect(update: ViewUpdate) {
  return update.transactions.some((transaction) =>
    transaction.effects.some((effect) => effect.is(setLiveMdViewportRanges)),
  );
}

function nextLiveMdVisibleRanges(snapshot: LiveMdRuntimeSnapshot, transaction: Transaction) {
  for (let effect of transaction.effects) {
    if (effect.is(setLiveMdViewportRanges)) return effect.value;
  }
  return transaction.docChanged
    ? mapLiveMdRanges(snapshot.visibleRanges, transaction.changes, transaction.state)
    : snapshot.visibleRanges;
}
