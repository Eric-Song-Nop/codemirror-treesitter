import {
  type ChangeDesc,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type RangeValue,
  type Transaction,
} from "@codemirror/state";
import {
  mergeDocRanges,
  patchRangeSet,
  rangesTouch,
  syntaxHighlighters,
  syntaxTree,
  syntaxTreeApplyTrace,
  syntaxTreeAvailable,
  syntaxTreeChangedRanges,
  type Highlighter,
  type Tree,
} from "@codemirror-treesitter/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { walkMarkdownBlocks } from "../analysis/markdown-block-cursor.js";
import { type LeafAnalysisRecord, type LiveMdDescriptor } from "../analysis/descriptors.js";
import {
  buildFreshLeafAnalysisCache,
  emptyLeafAnalysisCacheTrace,
  findLeafAnalysisRecordsTouchingRanges,
  leafAnalysisCacheRangesInDoc,
  materializeLeafAnalysisCacheRecords,
  transitionLeafAnalysisCacheLocal,
  transitionLeafAnalysisCache,
} from "../analysis/markdown-leaf-cache.js";
import {
  activeMarkdownSourceRanges,
  analyzeLiveMdSourceIslands,
  findSourceIslandLeaf,
  sourceIslandLeavesInDoc,
  sourceIslandLeavesFromLeafAnalysisRecords,
  type LiveMdSourceIslandAnalysis,
} from "../analysis/markdown-source-islands.js";
import { isInsideSkippedRange, matchRoot, queryLiveMdMatches } from "../analysis/query.js";
import { collectTable } from "../analysis/tables.js";
import {
  emptyLiveMdLeafAnalysisTrace,
  type CapturedTable,
  type DocRange,
  type LiveMdLeafAnalysisTrace,
} from "../analysis/types.js";
import { liveMdMarkdownFeatureFacet } from "../features.js";
import { liveMdImageSourceResolver } from "../images.js";
import {
  codeFenceHighlighterFacet,
  codeFenceLanguagesField,
  emptyCodeFenceLanguages,
  liveMdMarkdownParserServiceFacet,
  liveMdDefaultCodeFenceHighlighter,
  withLiveMdMarkdownInlineTrees,
  type CodeFenceLanguageMap,
  type LiveMdMarkdownParserService,
} from "../languages.js";
import { liveMdLinkBaseUrl } from "../links.js";
import {
  compileVisibleSurfaceProjection,
  compileVisibleSurfaceProjectionFromRecords,
  type LiveMdProjectionCompileInput,
} from "../projection/compilers.js";
import {
  createLiveMdBuild,
  finishProjectionLayers,
  type LiveMdProjectionLayer,
} from "../projection/emit.js";
import { applyLiveMdMarkdownFeatures, processLiveMdMatch } from "../projection/builtin.js";
import {
  liveMdEffectSpecLayerMapper,
  liveMdRecordMayProduceDirectLayout,
  projectLeafCacheRecords,
} from "../projection/project-leaf.js";
import {
  type LiveMdAnalysis,
  type LiveMdPendingAnalysis,
  type LiveMdRuntimeState,
  type LiveMdRuntimeEpochs,
  type LiveMdSemanticTrace,
} from "./types.js";

const defaultCodeFenceHighlighters = [liveMdDefaultCodeFenceHighlighter] as const;
const liveMdSchedulerQuietDelay = 24;
const liveMdSchedulerMaxDeadlineYields = 2;
const liveMdSurfaceMaxViewportLines = 400;

type BuildLiveMdAnalysisOptions = {
  activeSourceRanges?: readonly DocRange[] | null;
  previous?: LiveMdRuntimeState;
  revision?: number;
  transaction?: Transaction;
  transitionBase?: LiveMdPendingAnalysis;
  tree?: Tree;
  yieldCheck?: () => void;
};

type LiveMdScheduledAnalysis = {
  analysis: LiveMdRuntimeState;
  docLength: number;
  epochs: LiveMdRuntimeEpochs;
  revision: number;
};

type SurfaceProjection = LiveMdProjectionLayer;

type SurfaceProjectionSnapshot = {
  projection: SurfaceProjection;
  trace: LiveMdLeafAnalysisTrace;
};

const liveMdLegacySurfaceProjections = new WeakMap<LiveMdRuntimeState, SurfaceProjection>();

const commitLiveMdScheduledAnalysis = StateEffect.define<LiveMdScheduledAnalysis>();

const liveMdAnalysisField = StateField.define<LiveMdRuntimeState>({
  create(state) {
    return buildLiveMdAnalysis(state, getActiveLines(state), { revision: 0 });
  },
  update(value, transaction) {
    let committed = scheduledAnalysisFromEffects(transaction);
    if (committed) {
      if (canCommitScheduledAnalysis(value, transaction.state, committed)) {
        return committed.analysis;
      }
      return withStaleResultDrop(value);
    }

    if (transaction.docChanged) {
      return pendingSourceAnalysis(value, transaction);
    }

    if (value.pending) {
      return pendingSelectionAnalysis(value, transaction);
    }

    let tree = syntaxTree(transaction.state);
    let activeLines = getActiveLines(transaction.state);
    let activeSourceRanges =
      tree == value.tree && !transaction.docChanged
        ? activeMarkdownSourceRanges(transaction.state, value.sourceIslandLeaves)
        : null;
    let activeLinesStable = sameSetItems(activeLines, value.activeLines);
    let selectionProjectionStable =
      value.sourceIslandLeaves.length > 0
        ? activeSourceRanges != null && sameRanges(activeSourceRanges, value.activeSourceRanges)
        : activeLinesStable;
    let hasLegacyFeatures = hasLegacyDocumentQueryFeature(transaction.state);
    if (
      !hasLegacyFeatures &&
      tree == value.tree &&
      !transaction.docChanged &&
      selectionProjectionStable &&
      !codeFenceHighlightersChanged(transaction.startState, transaction.state) &&
      !codeFenceLanguagesChanged(transaction.startState, transaction.state) &&
      !markdownParserServiceChanged(transaction.startState, transaction.state) &&
      !markdownFeaturesChanged(transaction.startState, transaction.state) &&
      transaction.startState.facet(liveMdImageSourceResolver) ==
        transaction.state.facet(liveMdImageSourceResolver) &&
      transaction.startState.facet(liveMdLinkBaseUrl) == transaction.state.facet(liveMdLinkBaseUrl)
    ) {
      return value;
    }

    return buildLiveMdAnalysis(transaction.state, activeLines, {
      activeSourceRanges,
      previous: value,
      revision: value.revision,
      transaction,
      tree,
    });
  },
  provide(field) {
    return [
      EditorView.decorations.from(field, (analysis) => analysis.directDecorations),
      EditorView.atomicRanges.of(
        (view) => view.state.field(field, false)?.directAtomicRanges ?? RangeSet.empty,
      ),
    ];
  },
});

const liveMdSchedulerPlugin = ViewPlugin.fromClass(
  class LiveMdSchedulerPlugin {
    private destroyed = false;
    private scheduled: LiveMdScheduledWork | null = null;
    private yieldedRevision = -1;
    private yieldCount = 0;

    constructor(readonly view: EditorView) {
      this.scheduleIfPending();
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.transactions.some((transaction) => transaction.effects.length)
      ) {
        this.scheduleIfPending();
      } else if (
        update.startState.field(liveMdAnalysisField) != update.state.field(liveMdAnalysisField)
      ) {
        this.scheduleIfPending();
      }
    }

    destroy() {
      this.destroyed = true;
      this.scheduled?.cancel();
      this.scheduled = null;
    }

    private scheduleIfPending() {
      let pending = this.view.state.field(liveMdAnalysisField).pending;
      if (!pending) {
        this.scheduled?.cancel();
        this.scheduled = null;
        this.resetYieldCount();
        return;
      }
      if (this.yieldedRevision != pending.revision) this.resetYieldCount(pending.revision);
      if (this.scheduled?.revision == pending.revision) return;
      this.scheduled?.cancel();
      let allowDeadlineYield = this.yieldCount < liveMdSchedulerMaxDeadlineYields;
      this.scheduled = scheduleLiveMdWork(
        pending.revision,
        (deadline) => this.runScheduled(pending.revision, deadline),
        allowDeadlineYield,
      );
    }

    private runScheduled(revision: number, deadline?: IdleDeadline) {
      this.scheduled = null;
      if (this.destroyed) return;
      let current = this.view.state.field(liveMdAnalysisField, false);
      let pending = current?.pending;
      if (!pending || pending.revision != revision) return;
      if (!syntaxTreeAvailable(this.view.state, this.view.state.doc.length)) {
        this.scheduleIfPending();
        return;
      }

      let yieldCheck = scheduledYieldCheck(
        deadline,
        this.yieldCount < liveMdSchedulerMaxDeadlineYields,
      );
      let analysis: LiveMdRuntimeState;
      try {
        yieldCheck();
        analysis = buildLiveMdAnalysis(this.view.state, getActiveLines(this.view.state), {
          previous: pending.baseAnalysis,
          revision,
          transitionBase: pending,
          tree: syntaxTree(this.view.state),
          yieldCheck,
        });
        yieldCheck();
      } catch (error) {
        if (error instanceof LiveMdScheduledYield) {
          if (error.reason == "deadline") this.yieldCount++;
          this.scheduleIfPending();
          return;
        }
        throw error;
      }
      this.resetYieldCount();
      this.view.dispatch({
        effects: commitLiveMdScheduledAnalysis.of({
          analysis,
          docLength: this.view.state.doc.length,
          epochs: runtimeEpochs(this.view.state),
          revision,
        }),
      });
    }

    private resetYieldCount(revision = -1) {
      this.yieldedRevision = revision;
      this.yieldCount = 0;
    }
  },
);

const liveMdSurfacePlugin = ViewPlugin.fromClass(
  class LiveMdSurfacePlugin {
    atomicRanges = RangeSet.empty;
    decorations: DecorationSet = Decoration.none;
    surface = emptySurfaceProjection();
    surfaceTrace = emptyLiveMdLeafAnalysisTrace();
    private fallbackSurface: SurfaceProjection | null = null;
    private fallbackSurfaceState: EditorState | null = null;
    private fallbackSurfaceRuntime: LiveMdRuntimeState | null = null;

    constructor(readonly view: EditorView) {
      this.refresh();
    }

    update(update: ViewUpdate) {
      if (
        update.viewportChanged ||
        update.startState.field(liveMdAnalysisField) != update.state.field(liveMdAnalysisField)
      ) {
        this.refresh();
      }
    }

    private refresh() {
      let analysis = this.view.state.field(liveMdAnalysisField, false);
      let visibleRanges = liveMdSurfaceVisibleRanges(this.view);
      if (!analysis) {
        this.atomicRanges = RangeSet.empty;
        this.decorations = Decoration.none;
        this.surface = emptySurfaceProjection();
        this.surfaceTrace = emptyLiveMdLeafAnalysisTrace();
        return;
      }
      let surfaceTrace = emptyLiveMdLeafAnalysisTrace();
      let surface = compileRuntimeVisibleSurfaceProjection(
        this.view.state,
        analysis,
        visibleRanges,
        surfaceTrace,
      );
      let fallback = this.visibleFallbackSurface(analysis, visibleRanges);
      let merged = mergeSurfaceProjections(surface, fallback);
      this.surface = merged;
      this.surfaceTrace = surfaceTrace;
      this.atomicRanges = merged.atomicRanges;
      this.decorations = merged.decorations;
    }

    private visibleFallbackSurface(
      analysis: LiveMdRuntimeState,
      visibleRanges: readonly DocRange[],
    ): SurfaceProjection {
      let fallback = this.fallbackSurfaceFor(analysis);
      return {
        atomicRanges: filterRangeSetToRanges(fallback.atomicRanges, visibleRanges),
        decorations: filterRangeSetToRanges(fallback.decorations, visibleRanges),
        destructiveDecorations: filterRangeSetToRanges(
          fallback.destructiveDecorations,
          visibleRanges,
        ),
        interactiveDecorations: filterRangeSetToRanges(
          fallback.interactiveDecorations,
          visibleRanges,
        ),
        sourceSafeDecorations: filterRangeSetToRanges(
          fallback.sourceSafeDecorations,
          visibleRanges,
        ),
      };
    }

    private fallbackSurfaceFor(analysis: LiveMdRuntimeState): SurfaceProjection {
      if (
        this.fallbackSurface &&
        this.fallbackSurfaceState == this.view.state &&
        this.fallbackSurfaceRuntime == analysis
      ) {
        return this.fallbackSurface;
      }
      this.fallbackSurfaceState = this.view.state;
      this.fallbackSurfaceRuntime = analysis;
      this.fallbackSurface = compileRuntimeFallbackSurfaceProjection(this.view.state, analysis);
      return this.fallbackSurface;
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

export const liveMdAnalysis: Extension = [
  liveMdAnalysisField,
  liveMdSchedulerPlugin,
  liveMdSurfacePlugin,
  EditorView.atomicRanges.of(
    (view) => view.plugin(liveMdSurfacePlugin)?.atomicRanges ?? RangeSet.empty,
  ),
];

function liveMdSurfaceVisibleRanges(view: EditorView): readonly DocRange[] {
  let viewport = view.viewport;
  let ranges = view.visibleRanges
    .map((range) => intersectDocRanges(range, viewport))
    .filter((range): range is DocRange => Boolean(range));
  return clampRangesToLineBudget(view.state, ranges.length ? ranges : [viewport]);
}

function intersectDocRanges(left: DocRange, right: DocRange): DocRange | null {
  let from = Math.max(left.from, right.from);
  let to = Math.min(left.to, right.to);
  return from < to ? { from, to } : null;
}

function clampRangesToLineBudget(
  state: EditorState,
  ranges: readonly DocRange[],
): readonly DocRange[] {
  let remaining = liveMdSurfaceMaxViewportLines;
  let clamped: DocRange[] = [];
  for (let range of ranges) {
    if (remaining <= 0) break;
    let from = clamp(range.from, 0, state.doc.length);
    let to = clamp(range.to, 0, state.doc.length);
    if (from >= to) continue;
    let firstLine = state.doc.lineAt(from);
    let lastLine = state.doc.lineAt(Math.max(from, to - 1));
    let lineCount = lastLine.number - firstLine.number + 1;
    if (lineCount <= remaining) {
      clamped.push({ from, to });
      remaining -= lineCount;
      continue;
    }
    let lastVisibleLine = state.doc.line(firstLine.number + remaining - 1);
    clamped.push({ from, to: Math.min(to, lastVisibleLine.to) });
    remaining = 0;
  }
  return clamped;
}

type LiveMdScheduledWork = {
  cancel: () => void;
  revision: number;
};

class LiveMdScheduledYield extends Error {
  constructor(readonly reason: "deadline" | "input") {
    super(reason);
  }
}

function pendingSourceAnalysis(
  value: LiveMdRuntimeState,
  transaction: Transaction,
): LiveMdRuntimeState {
  let previousPending = value.pending;
  let baseAnalysis = previousPending?.baseAnalysis ?? value;
  let baseDoc = previousPending?.baseDoc ?? transaction.startState.doc;
  let changes = previousPending
    ? previousPending.changes.composeDesc(transaction.changes)
    : transaction.changes;
  let revision = (previousPending?.revision ?? value.revision) + 1;
  let syntaxChangedRanges = pendingSyntaxChangedRanges(previousPending, transaction);
  let safetyRanges = sourceSafetyRanges(baseAnalysis, transaction.state, changes);
  let interactiveSafetyRanges = sourceInteractiveSafetyRanges(
    baseAnalysis,
    transaction.state,
    changes,
    safetyRanges,
  );
  let pending: LiveMdPendingAnalysis = {
    baseAnalysis,
    baseDoc,
    changes,
    epochs: previousPending?.epochs ?? runtimeEpochs(transaction.startState),
    interactiveSafetyRanges,
    revision,
    safetyRanges,
    syntaxChangedRanges,
  };
  let activeLines = getActiveLines(transaction.state);
  let sourceIslandLeaves = baseAnalysis.sourceIslandLeaves;
  let activeSourceRanges = activePendingSourceRanges(
    transaction.state,
    baseDoc,
    sourceIslandLeaves,
    changes,
  );
  let directSourceSafeDecorations = value.directSourceSafeDecorations.map(transaction.changes);
  let directDestructiveDecorations = clearDecorationRanges(
    value.directDestructiveDecorations.map(transaction.changes),
    safetyRanges,
  );
  let directAtomicRanges = clearRangeSetRanges(
    value.directAtomicRanges.map(transaction.changes),
    safetyRanges,
  );
  let trace = pendingInputTrace(transaction);
  return {
    activeLines,
    activeSourceRanges,
    directAtomicRanges,
    directDecorations: joinDirectProjectionSets({
      directDestructiveDecorations,
      directSourceSafeDecorations,
    }),
    directDestructiveDecorations,
    directSourceSafeDecorations,
    pending,
    revision,
    semantic: baseAnalysis.semantic,
    semanticTrace: baseAnalysis.semantic ? emptyLeafAnalysisCacheTrace() : null,
    sourceIslandLeaves,
    trace,
    tree: value.tree,
  };
}

function pendingInputTrace(transaction: Transaction) {
  let trace = emptyLiveMdLeafAnalysisTrace();
  let languageTrace = syntaxTreeApplyTrace(transaction);
  trace.languageApplyMs = languageTrace.applyMs;
  trace.languageWorkIterations = languageTrace.workIterations;
  return trace;
}

function pendingSyntaxChangedRanges(
  previousPending: LiveMdPendingAnalysis | null,
  transaction: Transaction,
) {
  let previousRanges =
    previousPending?.syntaxChangedRanges.map((range) => mapRange(range, transaction.changes)) ?? [];
  return mergeDocRanges([...previousRanges, ...syntaxTreeChangedRanges(transaction)]);
}

function pendingSelectionAnalysis(
  value: LiveMdRuntimeState,
  transaction: Transaction,
): LiveMdRuntimeState {
  let activeLines = getActiveLines(transaction.state);
  let pending = value.pending;
  let activeSourceRanges = pending
    ? activePendingSourceRanges(
        transaction.state,
        pending.baseDoc,
        pending.baseAnalysis.sourceIslandLeaves,
        pending.changes,
      )
    : activeMarkdownSourceRanges(transaction.state, value.sourceIslandLeaves);
  let revealRanges = newlyActiveSourceRanges(value.activeSourceRanges, activeSourceRanges);
  if (
    sameSetItems(activeLines, value.activeLines) &&
    sameRanges(activeSourceRanges, value.activeSourceRanges)
  ) {
    return value;
  }
  let directDestructiveDecorations = clearDecorationRanges(
    value.directDestructiveDecorations,
    revealRanges,
  );
  let directAtomicRanges = clearRangeSetRanges(value.directAtomicRanges, revealRanges);
  return {
    ...value,
    activeLines,
    activeSourceRanges,
    directAtomicRanges,
    directDecorations: joinDirectProjectionSets({
      directDestructiveDecorations,
      directSourceSafeDecorations: value.directSourceSafeDecorations,
    }),
    directDestructiveDecorations,
    trace: emptyLiveMdLeafAnalysisTrace(),
  };
}

function sourceSafetyRanges(
  baseAnalysis: LiveMdRuntimeState,
  state: EditorState,
  changes: ChangeDesc,
): readonly DocRange[] {
  let ranges: DocRange[] = changedPhysicalLineRanges(state, changes);
  let oldChangedRanges = changedOldRanges(changes);

  if (baseAnalysis.semantic) {
    for (let record of findLeafAnalysisRecordsTouchingRanges(
      baseAnalysis.semantic.cache,
      oldChangedRanges,
    )) {
      ranges.push(mapRange(record.effectRange, changes));
    }
  }

  for (let activeRange of baseAnalysis.activeSourceRanges) {
    if (
      oldChangedRanges.some((range) =>
        rangesTouch(activeRange.from, activeRange.to, range.from, range.to),
      )
    ) {
      ranges.push(mapRange(activeRange, changes));
    }
  }

  return mergeDocRanges(ranges.map((range) => clampRangeToDoc(range, state)));
}

function sourceInteractiveSafetyRanges(
  baseAnalysis: LiveMdRuntimeState,
  state: EditorState,
  changes: ChangeDesc,
  fallbackRanges: readonly DocRange[],
): readonly DocRange[] {
  if (!baseAnalysis.semantic) return fallbackRanges;

  let oldChangedRanges = changedOldRanges(changes);
  let ranges: DocRange[] = [];
  for (let record of findLeafAnalysisRecordsTouchingRanges(
    baseAnalysis.semantic.cache,
    oldChangedRanges,
  )) {
    for (let descriptor of record.analysis.descriptors) {
      if (!isDirtyLinkDescriptor(descriptor, oldChangedRanges, record.sourceRange.from)) continue;
      ranges.push(mapRange(offsetDocRange(descriptor.range, record.sourceRange.from), changes));
    }
  }

  return mergeDocRanges(ranges.map((range) => clampRangeToDoc(range, state)));
}

function isDirtyLinkDescriptor(
  descriptor: LiveMdDescriptor,
  oldChangedRanges: readonly DocRange[],
  sourceOffset: number,
) {
  if (descriptor.kind != "linkMark") return false;
  let sourceRange = offsetDocRange(descriptor.sourceRange, sourceOffset);
  return oldChangedRanges.some((range) => docRangesTouch(sourceRange, range));
}

function changedOldRanges(changes: ChangeDesc): DocRange[] {
  let ranges: DocRange[] = [];
  changes.iterChangedRanges((fromA, toA) => {
    ranges.push({ from: fromA, to: toA });
  }, true);
  return ranges;
}

function changedPhysicalLineRanges(state: EditorState, changes: ChangeDesc): DocRange[] {
  let ranges: DocRange[] = [];
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    ranges.push(lineRangeFor(state, fromB, toB));
  }, true);
  return ranges;
}

function clearDecorationRanges(decorations: DecorationSet, ranges: readonly DocRange[]) {
  return clearRangeSetRanges(decorations, ranges);
}

type ProjectionSetInputs = {
  directAtomicRanges: RangeSet<RangeValue>;
  directDestructiveDecorations: DecorationSet;
  directSourceSafeDecorations: DecorationSet;
  surfaceAtomicRanges: RangeSet<RangeValue>;
  surfaceDestructiveDecorations: DecorationSet;
  surfaceInteractiveDecorations: DecorationSet;
  surfaceSourceSafeDecorations: DecorationSet;
};

type DirectProjectionSetInputs = Pick<
  ProjectionSetInputs,
  "directDestructiveDecorations" | "directSourceSafeDecorations"
>;

function joinDirectProjectionSets(input: DirectProjectionSetInputs) {
  return RangeSet.join([input.directSourceSafeDecorations, input.directDestructiveDecorations]);
}

function joinProjectionSets(input: ProjectionSetInputs) {
  let directDecorations = RangeSet.join([
    input.directSourceSafeDecorations,
    input.directDestructiveDecorations,
  ]);
  let surfaceDecorations = RangeSet.join([
    input.surfaceSourceSafeDecorations,
    input.surfaceInteractiveDecorations,
    input.surfaceDestructiveDecorations,
  ]);
  let sourceSafeDecorations = RangeSet.join([
    input.directSourceSafeDecorations,
    input.surfaceSourceSafeDecorations,
  ]);
  let destructiveDecorations = RangeSet.join([
    input.directDestructiveDecorations,
    input.surfaceDestructiveDecorations,
  ]);
  return {
    atomicRanges: RangeSet.join([input.directAtomicRanges, input.surfaceAtomicRanges]),
    decorations: RangeSet.join([directDecorations, surfaceDecorations]),
    destructiveDecorations,
    directDecorations,
    interactiveDecorations: input.surfaceInteractiveDecorations,
    sourceSafeDecorations,
    surfaceDecorations,
  };
}

function filterRangeSetToRanges<T extends RangeValue>(
  rangeSet: RangeSet<T>,
  ranges: readonly DocRange[],
): RangeSet<T> {
  if (!ranges.length) return RangeSet.empty;
  let collected: Array<{ from: number; to: number; value: T }> = [];
  let builder = new RangeSetBuilder<T>();
  for (let range of ranges) {
    rangeSet.between(range.from, range.to, (from, to, value) => {
      collected.push({ from, to, value });
    });
  }
  collected.sort(
    (left, right) =>
      left.from - right.from ||
      left.value.startSide - right.value.startSide ||
      left.to - right.to ||
      left.value.endSide - right.value.endSide,
  );
  for (let range of collected) {
    builder.add(range.from, range.to, range.value);
  }
  return builder.finish();
}

function newlyActiveSourceRanges(
  previous: readonly DocRange[],
  current: readonly DocRange[],
): readonly DocRange[] {
  return current.filter(
    (range) => !previous.some((oldRange) => range.from == oldRange.from && range.to == oldRange.to),
  );
}

function activePendingSourceRanges(
  state: EditorState,
  baseDoc: LiveMdPendingAnalysis["baseDoc"],
  leaves: LiveMdRuntimeState["sourceIslandLeaves"],
  changes: ChangeDesc,
): readonly DocRange[] {
  if (!leaves.length) return [];
  let active: DocRange[] = [];
  let seen = new Set<string>();
  let inverseChanges = changes.invertedDesc;
  for (let range of state.selection.ranges) {
    let oldHead = inverseChanges.mapPos(range.head, range.assoc);
    let leaf = findSourceIslandLeaf(baseDoc, leaves, oldHead, range.assoc);
    if (!leaf) continue;
    let sourceRange = mapInclusiveRange(leaf.sourceRange, changes);
    let key = `${sourceRange.from}:${sourceRange.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    active.push(sourceRange);
  }
  return active;
}

function clearRangeSetRanges<T extends RangeValue>(
  rangeSet: RangeSet<T>,
  ranges: readonly DocRange[],
) {
  return ranges.length ? patchRangeSet(rangeSet, ranges, []) : rangeSet;
}

function scheduledAnalysisFromEffects(transaction: Transaction): LiveMdScheduledAnalysis | null {
  for (let effect of transaction.effects) {
    if (effect.is(commitLiveMdScheduledAnalysis)) return effect.value;
  }
  return null;
}

function canCommitScheduledAnalysis(
  value: LiveMdRuntimeState,
  state: EditorState,
  result: LiveMdScheduledAnalysis,
) {
  return Boolean(
    value.pending &&
    value.pending.revision == result.revision &&
    result.docLength == state.doc.length &&
    !runtimeEpochsChanged(result.epochs, runtimeEpochs(state)) &&
    result.analysis.revision == result.revision &&
    !result.analysis.pending &&
    analysisRangesInDoc(result.analysis, state.doc.length),
  );
}

function withStaleResultDrop(value: LiveMdRuntimeState): LiveMdRuntimeState {
  let trace = { ...value.trace, staleResultDrops: value.trace.staleResultDrops + 1 };
  return {
    ...value,
    semanticTrace: value.semanticTrace
      ? { ...value.semanticTrace, staleResultDrops: trace.staleResultDrops }
      : null,
    trace,
  };
}

function analysisRangesInDoc(analysis: LiveMdRuntimeState, docLength: number) {
  return (
    rangesInDoc(analysis.activeSourceRanges, docLength) &&
    sourceIslandLeavesInDoc(analysis.sourceIslandLeaves, docLength) &&
    (!analysis.semantic || leafAnalysisCacheRangesInDoc(analysis.semantic.cache, docLength))
  );
}

function rangesInDoc(ranges: readonly DocRange[], docLength: number) {
  return ranges.every(
    (range) => range.from >= 0 && range.from <= range.to && range.to <= docLength,
  );
}

function runtimeEpochs(state: EditorState): LiveMdRuntimeEpochs {
  return {
    codeFenceHighlighters: codeFenceHighlighters(state),
    codeFenceLanguages: state.field(codeFenceLanguagesField, false) ?? null,
    imageSourceResolver: state.facet(liveMdImageSourceResolver),
    linkBaseUrl: state.facet(liveMdLinkBaseUrl),
    markdownFeatures: state.facet(liveMdMarkdownFeatureFacet),
    markdownParserService: state.facet(liveMdMarkdownParserServiceFacet),
  };
}

function runtimeEpochsChanged(left: LiveMdRuntimeEpochs, right: LiveMdRuntimeEpochs) {
  return (
    left.codeFenceLanguages != right.codeFenceLanguages ||
    !sameArrayItems(left.codeFenceHighlighters, right.codeFenceHighlighters) ||
    left.imageSourceResolver != right.imageSourceResolver ||
    left.linkBaseUrl != right.linkBaseUrl ||
    !sameArrayItems(left.markdownFeatures, right.markdownFeatures) ||
    left.markdownParserService != right.markdownParserService
  );
}

function scheduleLiveMdWork(
  revision: number,
  run: (deadline?: IdleDeadline) => void,
  allowDeadlineYield = true,
): LiveMdScheduledWork {
  let cancelled = false;
  let frame: number | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idle: number | null = null;

  let scheduleQuietTask = () => {
    frame = null;
    if (cancelled) return;
    quietTimer = setTimeout(scheduleIdleTask, liveMdSchedulerQuietDelay);
  };

  let scheduleIdleTask = () => {
    quietTimer = null;
    if (cancelled) return;
    if (isInputPending()) {
      scheduleQuietTask();
      return;
    }
    let requestIdle = globalThis.requestIdleCallback;
    if (typeof requestIdle == "function") {
      idle = requestIdle((deadline) => {
        idle = null;
        if (cancelled) return;
        if (isInputPending() || (allowDeadlineYield && idleDeadlineExhausted(deadline))) {
          scheduleQuietTask();
          return;
        }
        run(deadline);
      });
    } else {
      timer = setTimeout(() => {
        timer = null;
        if (cancelled) return;
        if (isInputPending()) {
          scheduleQuietTask();
          return;
        }
        run();
      }, 0);
    }
  };

  if (typeof globalThis.requestAnimationFrame == "function") {
    frame = globalThis.requestAnimationFrame(scheduleQuietTask);
  } else {
    timer = setTimeout(scheduleQuietTask, 0);
  }

  return {
    cancel() {
      cancelled = true;
      if (frame != null && typeof globalThis.cancelAnimationFrame == "function") {
        globalThis.cancelAnimationFrame(frame);
      }
      if (idle != null && typeof globalThis.cancelIdleCallback == "function") {
        globalThis.cancelIdleCallback(idle);
      }
      if (quietTimer != null) clearTimeout(quietTimer);
      if (timer != null) clearTimeout(timer);
    },
    revision,
  };
}

function isInputPending() {
  return Boolean(
    typeof navigator != "undefined" &&
    (
      navigator as Navigator & {
        scheduling?: { isInputPending?: () => boolean };
      }
    ).scheduling?.isInputPending?.(),
  );
}

function idleDeadlineExhausted(deadline: IdleDeadline | undefined) {
  return Boolean(deadline && !deadline.didTimeout && deadline.timeRemaining() <= 0);
}

function scheduledYieldCheck(deadline: IdleDeadline | undefined, allowDeadlineYield: boolean) {
  return () => {
    if (isInputPending()) throw new LiveMdScheduledYield("input");
    if (allowDeadlineYield && idleDeadlineExhausted(deadline)) {
      throw new LiveMdScheduledYield("deadline");
    }
  };
}

function mapRange(range: DocRange, changes: ChangeDesc): DocRange {
  let from = changes.mapPos(clamp(range.from, 0, changes.length), 1);
  let to = changes.mapPos(clamp(range.to, 0, changes.length), -1);
  return from <= to ? { from, to } : { from: to, to: from };
}

function offsetDocRange(range: DocRange, offset: number): DocRange {
  return { from: range.from + offset, to: range.to + offset };
}

function docRangesTouch(left: DocRange, right: DocRange) {
  return rangesTouch(left.from, left.to, right.from, right.to);
}

function mapInclusiveRange(range: DocRange, changes: ChangeDesc): DocRange {
  let from = changes.mapPos(clamp(range.from, 0, changes.length), -1);
  let to = changes.mapPos(clamp(range.to, 0, changes.length), 1);
  return from <= to ? { from, to } : { from: to, to: from };
}

function clampRangeToDoc(range: DocRange, state: EditorState): DocRange {
  return {
    from: clamp(range.from, 0, state.doc.length),
    to: clamp(range.to, 0, state.doc.length),
  };
}

function lineRangeFor(state: EditorState, from: number, to: number): DocRange {
  let rangeFrom = clamp(from, 0, state.doc.length);
  let rangeTo = clamp(to, 0, state.doc.length);
  let firstLine = state.doc.lineAt(rangeFrom);
  let lastLine = state.doc.lineAt(Math.max(rangeFrom, rangeTo - 1));
  return { from: firstLine.from, to: rangeTo >= state.doc.length ? rangeTo : lastLine.to };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildLiveMdAnalysis(
  state: EditorState,
  activeLines = getActiveLines(state),
  options: BuildLiveMdAnalysisOptions = {},
): LiveMdRuntimeState {
  let codeFenceLanguages = state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages;
  let tree = options.tree ?? syntaxTree(state);
  let markdownParserService = state.facet(liveMdMarkdownParserServiceFacet);

  if (markdownParserService) {
    let semanticAnalysis = buildLiveMdSemanticAnalysis({
      activeSourceRanges: options.activeSourceRanges,
      previous: options.previous,
      service: markdownParserService,
      state,
      transaction: options.transaction,
      transitionBase: options.transitionBase,
      tree,
      yieldCheck: options.yieldCheck,
    });
    let compileInput = projectionCompileInput(
      state,
      activeLines,
      semanticAnalysis.activeSourceRanges,
      {
        codeFenceLanguages,
        sourceIslandMode: true,
        trace: semanticAnalysis.trace,
        yieldCheck: options.yieldCheck,
      },
    );
    let build = createLiveMdBuild(compileInput);
    projectLeafCacheRecords(
      build,
      semanticAnalysis.semantic.cache,
      liveMdEffectSpecLayerMapper("direct"),
      liveMdRecordMayProduceDirectLayout,
    );
    let legacyFeatureFullQueryCount = applyLegacyMarkdownFeatures(
      build,
      markdownParserService,
      tree,
    );
    let projection = finishProjectionLayers(build);
    let direct = projection.direct;
    let trace = liveMdSemanticTrace(semanticAnalysis.trace, legacyFeatureFullQueryCount);
    let analysis: LiveMdRuntimeState = {
      activeLines,
      activeSourceRanges: semanticAnalysis.activeSourceRanges,
      directAtomicRanges: direct.atomicRanges,
      directDecorations: direct.decorations,
      directDestructiveDecorations: direct.destructiveDecorations,
      directSourceSafeDecorations: direct.sourceSafeDecorations,
      pending: null,
      revision: options.revision ?? options.previous?.revision ?? 0,
      semantic: semanticAnalysis.semantic,
      semanticTrace: trace,
      sourceIslandLeaves: semanticAnalysis.sourceIslandLeaves,
      trace,
      tree,
    };
    if (legacyFeatureFullQueryCount) {
      liveMdLegacySurfaceProjections.set(analysis, projection.surface);
    }
    return analysis;
  }

  let build = buildLegacyLiveMdBuild(
    state,
    activeLines,
    codeFenceLanguages,
    null,
    tree,
    options.yieldCheck,
  );
  let projection = finishProjectionLayers(build);
  return {
    activeLines,
    activeSourceRanges: [],
    directAtomicRanges: projection.direct.atomicRanges,
    directDecorations: projection.direct.decorations,
    directDestructiveDecorations: projection.direct.destructiveDecorations,
    directSourceSafeDecorations: projection.direct.sourceSafeDecorations,
    pending: null,
    revision: options.revision ?? options.previous?.revision ?? 0,
    semantic: null,
    semanticTrace: null,
    sourceIslandLeaves: [],
    trace: build.trace,
    tree,
  };
}

function projectionCompileInput(
  state: EditorState,
  activeLines: Set<number> | ReadonlySet<number>,
  activeSourceRanges: readonly DocRange[],
  options: {
    codeFenceLanguages?: CodeFenceLanguageMap;
    sourceIslandMode: boolean;
    trace: LiveMdSemanticTrace;
    yieldCheck?: () => void;
  },
): LiveMdProjectionCompileInput {
  return {
    activeLines: new Set(activeLines),
    activeSourceRanges,
    codeFenceHighlighters: codeFenceHighlighters(state),
    codeFenceLanguages:
      options.codeFenceLanguages ??
      state.field(codeFenceLanguagesField, false) ??
      emptyCodeFenceLanguages,
    imageSourceResolver: state.facet(liveMdImageSourceResolver),
    linkBaseUrl: state.facet(liveMdLinkBaseUrl),
    markdownFeatures: state.facet(liveMdMarkdownFeatureFacet),
    sourceIslandMode: options.sourceIslandMode,
    state,
    trace: options.trace,
    yieldCheck: options.yieldCheck,
  };
}

function mergeProjectionLayers(
  primary: LiveMdProjectionLayer,
  secondary: LiveMdProjectionLayer,
): LiveMdProjectionLayer {
  return {
    atomicRanges: RangeSet.join([primary.atomicRanges, secondary.atomicRanges]),
    decorations: RangeSet.join([primary.decorations, secondary.decorations]),
    destructiveDecorations: RangeSet.join([
      primary.destructiveDecorations,
      secondary.destructiveDecorations,
    ]),
    interactiveDecorations: RangeSet.join([
      primary.interactiveDecorations,
      secondary.interactiveDecorations,
    ]),
    sourceSafeDecorations: RangeSet.join([
      primary.sourceSafeDecorations,
      secondary.sourceSafeDecorations,
    ]),
  };
}

function mergeSurfaceProjections(
  primary: SurfaceProjection,
  secondary: SurfaceProjection,
): SurfaceProjection {
  return mergeProjectionLayers(primary, secondary);
}

function compileRuntimeVisibleSurfaceProjection(
  state: EditorState,
  analysis: LiveMdRuntimeState,
  ranges: readonly DocRange[],
  trace = emptyLiveMdLeafAnalysisTrace(),
): SurfaceProjection {
  if (!ranges.length) return emptySurfaceProjection();
  let semantic = analysis.pending?.baseAnalysis.semantic ?? analysis.semantic;
  if (!semantic) return emptySurfaceProjection();

  let input = projectionCompileInput(state, analysis.activeLines, analysis.activeSourceRanges, {
    sourceIslandMode: true,
    trace,
  });
  if (!analysis.pending) {
    return compileVisibleSurfaceProjection(input, semantic.cache, ranges);
  }

  let oldRanges = ranges.map((range) => mapRange(range, analysis.pending!.changes.invertedDesc));
  let records = findLeafAnalysisRecordsTouchingRanges(semantic.cache, oldRanges)
    .map((record) => mapLeafAnalysisRecord(record, analysis.pending!.changes))
    .filter((record) => leafAnalysisRecordRangesInDoc(record, state.doc.length));
  let surface = compileVisibleSurfaceProjectionFromRecords(input, records, ranges, {
    codeFenceHighlights: false,
  });
  return clearPendingSurfaceProjection(surface, analysis.pending);
}

function compileRuntimeFallbackSurfaceProjection(
  state: EditorState,
  analysis: LiveMdRuntimeState,
): SurfaceProjection {
  if (analysis.pending) return emptySurfaceProjection();

  let codeFenceLanguages = state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages;
  if (analysis.semantic) {
    let cached = liveMdLegacySurfaceProjections.get(analysis);
    if (cached) return cached;
    let markdownParserService = state.facet(liveMdMarkdownParserServiceFacet);
    if (!markdownParserService || !hasLegacyDocumentQueryFeature(state)) {
      return emptySurfaceProjection();
    }
    let input = projectionCompileInput(state, analysis.activeLines, analysis.activeSourceRanges, {
      codeFenceLanguages,
      sourceIslandMode: true,
      trace: emptyLiveMdLeafAnalysisTrace(),
    });
    let build = createLiveMdBuild(input);
    applyLegacyMarkdownFeatures(build, markdownParserService, syntaxTree(state));
    let surface = finishProjectionLayers(build).surface;
    liveMdLegacySurfaceProjections.set(analysis, surface);
    return surface;
  }

  let build = buildLegacyLiveMdBuild(
    state,
    new Set(analysis.activeLines),
    codeFenceLanguages,
    null,
    syntaxTree(state),
  );
  return finishProjectionLayers(build).surface;
}

function clearPendingSurfaceProjection(
  surface: SurfaceProjection,
  pending: LiveMdPendingAnalysis,
): SurfaceProjection {
  let destructiveDecorations = clearDecorationRanges(
    surface.destructiveDecorations,
    pending.safetyRanges,
  );
  let interactiveDecorations = clearDecorationRanges(
    surface.interactiveDecorations,
    pending.interactiveSafetyRanges,
  );
  let atomicRanges = clearRangeSetRanges(surface.atomicRanges, pending.safetyRanges);
  return {
    atomicRanges,
    decorations: RangeSet.join([
      surface.sourceSafeDecorations,
      interactiveDecorations,
      destructiveDecorations,
    ]),
    destructiveDecorations,
    interactiveDecorations,
    sourceSafeDecorations: surface.sourceSafeDecorations,
  };
}

function emptySurfaceProjection(): SurfaceProjection {
  return {
    atomicRanges: RangeSet.empty,
    decorations: Decoration.none,
    destructiveDecorations: Decoration.none,
    interactiveDecorations: Decoration.none,
    sourceSafeDecorations: Decoration.none,
  };
}

function mapLeafAnalysisRecord(
  record: LeafAnalysisRecord,
  changes: ChangeDesc,
): LeafAnalysisRecord {
  let sourceRange = mapRange(record.sourceRange, changes);
  let mapped: LeafAnalysisRecord = {
    ...record,
    analysis: {
      ...record.analysis,
      descriptors: record.analysis.descriptors.map((descriptor) =>
        mapRelativeDescriptor(descriptor, record.sourceRange.from, sourceRange.from, changes),
      ),
      structuralEffects: record.analysis.structuralEffects.map((descriptor) =>
        mapRelativeDescriptor(descriptor, record.sourceRange.from, sourceRange.from, changes),
      ),
    },
    context: mapMarkdownBlockContext(record.context, changes),
    effectRange: mapRange(record.effectRange, changes),
    range: mapRange(record.range, changes),
    sourceRange,
  };
  if (record.cacheSourceRange) {
    mapped.cacheSourceRange = mapRange(record.cacheSourceRange, changes);
  }
  return mapped;
}

function mapRelativeDescriptor(
  descriptor: LiveMdDescriptor,
  oldSourceOffset: number,
  newSourceOffset: number,
  changes: ChangeDesc,
): LiveMdDescriptor {
  let mapRelativeRange = (range: DocRange) =>
    offsetRange(mapRange(offsetRange(range, oldSourceOffset), changes), -newSourceOffset);
  switch (descriptor.kind) {
    case "lineClass":
      return { ...descriptor, range: mapRelativeRange(descriptor.range) };
    case "syntax":
      return { ...descriptor, range: mapRelativeRange(descriptor.range) };
    case "textMark":
      return { ...descriptor, range: mapRelativeRange(descriptor.range) };
    case "linkMark":
      return {
        ...descriptor,
        range: mapRelativeRange(descriptor.range),
        sourceRange: mapRelativeRange(descriptor.sourceRange),
      };
    case "listMarker":
      return { ...descriptor, range: mapRelativeRange(descriptor.range) };
    case "taskMarker":
      return { ...descriptor, range: mapRelativeRange(descriptor.range) };
    case "image":
      return {
        ...descriptor,
        descriptionRange: descriptor.descriptionRange
          ? mapRelativeRange(descriptor.descriptionRange)
          : null,
        destinationRange: descriptor.destinationRange
          ? mapRelativeRange(descriptor.destinationRange)
          : null,
        lineRange: mapRelativeRange(descriptor.lineRange),
        range: mapRelativeRange(descriptor.range),
      };
    case "latex":
      return {
        ...descriptor,
        formula: {
          ...descriptor.formula,
          replacementRange: {
            ...mapRelativeRange(descriptor.formula.replacementRange),
            block: descriptor.formula.replacementRange.block,
          },
        },
        range: mapRelativeRange(descriptor.range),
      };
    case "table":
      return {
        ...descriptor,
        delimiterRowRange: descriptor.delimiterRowRange
          ? mapRelativeRange(descriptor.delimiterRowRange)
          : null,
        pipeRanges: descriptor.pipeRanges.map(mapRelativeRange),
        range: mapRelativeRange(descriptor.range),
      };
    case "codeFence":
      return {
        ...descriptor,
        closingDelimiterRange: descriptor.closingDelimiterRange
          ? mapRelativeRange(descriptor.closingDelimiterRange)
          : null,
        contentRange: descriptor.contentRange ? mapRelativeRange(descriptor.contentRange) : null,
        openingDelimiterRange: mapRelativeRange(descriptor.openingDelimiterRange),
        range: mapRelativeRange(descriptor.range),
      };
  }
}

function offsetRange(range: DocRange, offset: number): DocRange {
  return { from: range.from + offset, to: range.to + offset };
}

function mapMarkdownBlockContext(
  context: LeafAnalysisRecord["context"],
  changes: ChangeDesc,
): LeafAnalysisRecord["context"] {
  return {
    listPath: context.listPath.map((item) => ({
      ...item,
      itemRange: mapContextOwnerRange(item.itemRange, changes),
      markerRange: mapRange(item.markerRange, changes),
      task: item.task
        ? {
            ...item.task,
            range: mapRange(item.task.range, changes),
          }
        : null,
    })),
    quoteDepth: context.quoteDepth,
    quoteMarkers: context.quoteMarkers.map((range) => mapRange(range, changes)),
  };
}

function mapContextOwnerRange(range: DocRange, changes: ChangeDesc): DocRange {
  let fromOverhang = Math.max(0, range.from - changes.length);
  let toOverhang = Math.max(0, range.to - changes.length);
  let from = changes.mapPos(clamp(range.from, 0, changes.length), 1) + fromOverhang;
  let to = changes.mapPos(clamp(range.to, 0, changes.length), -1) + toOverhang;
  return from <= to ? { from, to } : { from: to, to: from };
}

function leafAnalysisRecordRangesInDoc(record: LeafAnalysisRecord, docLength: number) {
  return (
    rangeInDoc(record.range, docLength) &&
    rangeInDoc(record.sourceRange, docLength) &&
    rangeInDoc(record.effectRange, docLength) &&
    (!record.cacheSourceRange || rangeInDoc(record.cacheSourceRange, docLength))
  );
}

function rangeInDoc(range: DocRange, docLength: number) {
  return range.from >= 0 && range.from <= range.to && range.to <= docLength;
}

function buildLiveMdSemanticAnalysis(input: {
  activeSourceRanges?: readonly DocRange[] | null;
  previous?: LiveMdRuntimeState;
  service: LiveMdMarkdownParserService;
  state: EditorState;
  transaction?: Transaction;
  transitionBase?: LiveMdPendingAnalysis;
  tree: Tree;
  yieldCheck?: () => void;
}) {
  let previous = input.previous;
  let previousSemantic = input.previous?.semantic ?? null;
  if (previous && previousSemantic && canReuseSemanticState(input)) {
    let sourceIslandLeaves = previous.sourceIslandLeaves;
    return {
      activeSourceRanges:
        input.activeSourceRanges ?? activeMarkdownSourceRanges(input.state, sourceIslandLeaves),
      semantic: previousSemantic,
      sourceIslandLeaves,
      trace: emptyLeafAnalysisCacheTrace(),
    };
  }

  let transaction = input.transaction;
  let transitionBase = input.transitionBase;
  if (
    previousSemantic &&
    transitionBase &&
    transitionBase.epochs.markdownParserService == input.service
  ) {
    let transition = transitionLeafAnalysisCacheLocal({
      analysisInput: {
        service: input.service,
        state: input.state,
        tree: input.tree,
      },
      changes: transitionBase.changes,
      oldCache: previousSemantic.cache,
      oldDoc: transitionBase.baseDoc,
      oldSourceIslandLeaves: transitionBase.baseAnalysis.sourceIslandLeaves,
      syntaxChangedRanges: transitionBase.syntaxChangedRanges,
      yieldCheck: input.yieldCheck,
    });
    if (!transition.fallback) {
      let sourceIslandLeaves =
        transition.sourceIslandLeaves ??
        sourceIslandLeavesFromLeafAnalysisRecords(
          input.state.doc,
          materializeLeafAnalysisCacheRecords(transition.cache),
        );
      return {
        activeSourceRanges: activeMarkdownSourceRanges(input.state, sourceIslandLeaves),
        semantic: {
          cache: transition.cache,
          revision: (previousSemantic.revision ?? 0) + 1,
        },
        sourceIslandLeaves,
        trace: transition.trace,
      };
    }

    input.yieldCheck?.();
    let walked = walkMarkdownBlocks(input.tree, input.state.doc);
    input.yieldCheck?.();
    let fallback = transitionLeafAnalysisCache({
      analysisInput: {
        service: input.service,
        state: input.state,
        tree: input.tree,
      },
      changes: transitionBase.changes,
      oldCache: previousSemantic.cache,
      oldDoc: transitionBase.baseDoc,
      snapshot: walked.snapshot,
      yieldCheck: input.yieldCheck,
    });
    fallback.trace.blockNodesVisited = walked.trace.visitedBlockNodes;
    fallback.trace.checkedRanges = [{ from: 0, to: input.state.doc.length }];
    fallback.trace.fallbackCount = 1;
    fallback.trace.fixedPointRounds = transition.trace.fixedPointRounds;
    fallback.trace.leavesCollected = walked.snapshot.leaves.length + walked.snapshot.markers.length;
    let sourceIslandLeaves = sourceIslandLeavesFromLeafAnalysisRecords(
      input.state.doc,
      materializeLeafAnalysisCacheRecords(fallback.cache),
    );
    return {
      activeSourceRanges: activeMarkdownSourceRanges(input.state, sourceIslandLeaves),
      semantic: {
        cache: fallback.cache,
        revision: (previousSemantic.revision ?? 0) + 1,
      },
      sourceIslandLeaves,
      trace: fallback.trace,
    };
  }

  input.yieldCheck?.();
  let walked = walkMarkdownBlocks(input.tree, input.state.doc);
  input.yieldCheck?.();
  let transition =
    previousSemantic &&
    transaction &&
    !markdownParserServiceChanged(transaction.startState, transaction.state)
      ? transitionLeafAnalysisCache({
          analysisInput: {
            service: input.service,
            state: input.state,
            tree: input.tree,
          },
          changes: transaction.changes,
          oldCache: previousSemantic.cache,
          oldDoc: transaction.startState.doc,
          snapshot: walked.snapshot,
          yieldCheck: input.yieldCheck,
        })
      : buildFreshLeafAnalysisCache({
          analysisInput: {
            service: input.service,
            state: input.state,
            tree: input.tree,
          },
          snapshot: walked.snapshot,
          startCacheId: previousSemantic?.cache.nextCacheId,
          yieldCheck: input.yieldCheck,
        });

  transition.trace.blockNodesVisited = walked.trace.visitedBlockNodes;
  transition.trace.checkedRanges = walked.trace.checkedRanges;
  let sourceIslandLeaves = sourceIslandLeavesFromLeafAnalysisRecords(
    input.state.doc,
    materializeLeafAnalysisCacheRecords(transition.cache),
  );
  let activeSourceRanges = activeMarkdownSourceRanges(input.state, sourceIslandLeaves);

  return {
    activeSourceRanges,
    semantic: {
      cache: transition.cache,
      revision: (previousSemantic?.revision ?? 0) + 1,
    },
    sourceIslandLeaves,
    trace: transition.trace,
  };
}

function liveMdSemanticTrace(
  trace: LiveMdSemanticTrace,
  legacyFeatureFullQueryCount: number,
): LiveMdSemanticTrace {
  trace.legacyFeatureFullQueryCount = legacyFeatureFullQueryCount;
  return trace;
}

function canReuseSemanticState(input: {
  previous?: LiveMdRuntimeState;
  state: EditorState;
  transaction?: Transaction;
  tree: Tree;
}) {
  return Boolean(
    input.previous?.semantic &&
    input.transaction &&
    input.tree == input.previous.tree &&
    !input.transaction.docChanged &&
    !markdownParserServiceChanged(input.transaction.startState, input.state),
  );
}

const liveMdAnalysisSnapshots = new WeakMap<LiveMdRuntimeState, LiveMdAnalysis>();

function compileRuntimeSurfaceSnapshot(
  state: EditorState,
  runtime: LiveMdRuntimeState,
): SurfaceProjectionSnapshot {
  let ranges = state.doc.length ? [{ from: 0, to: state.doc.length }] : [];
  let trace = emptyLiveMdLeafAnalysisTrace();
  let projection = mergeSurfaceProjections(
    compileRuntimeVisibleSurfaceProjection(state, runtime, ranges, trace),
    compileRuntimeFallbackSurfaceProjection(state, runtime),
  );
  return { projection, trace };
}

function liveMdAnalysisSnapshot(
  state: EditorState,
  runtime: LiveMdRuntimeState,
  surfaceSnapshot?: SurfaceProjectionSnapshot,
): LiveMdAnalysis {
  let cached = liveMdAnalysisSnapshots.get(runtime);
  if (cached) return cached;

  surfaceSnapshot ??= compileRuntimeSurfaceSnapshot(state, runtime);
  let surface = surfaceSnapshot.projection;
  let projection = joinProjectionSets({
    directAtomicRanges: runtime.directAtomicRanges,
    directDestructiveDecorations: runtime.directDestructiveDecorations,
    directSourceSafeDecorations: runtime.directSourceSafeDecorations,
    surfaceAtomicRanges: surface.atomicRanges,
    surfaceDestructiveDecorations: surface.destructiveDecorations,
    surfaceInteractiveDecorations: surface.interactiveDecorations,
    surfaceSourceSafeDecorations: surface.sourceSafeDecorations,
  });
  let snapshot: LiveMdAnalysis = {
    ...runtime,
    atomicRanges: projection.atomicRanges,
    decorations: projection.decorations,
    destructiveDecorations: projection.destructiveDecorations,
    interactiveDecorations: projection.interactiveDecorations,
    sourceSafeDecorations: projection.sourceSafeDecorations,
    surfaceAtomicRanges: surface.atomicRanges,
    surfaceDecorations: surface.decorations,
    surfaceDestructiveDecorations: surface.destructiveDecorations,
    surfaceInteractiveDecorations: surface.interactiveDecorations,
    surfaceSourceSafeDecorations: surface.sourceSafeDecorations,
    trace: mergeLiveMdLeafAnalysisTraces(runtime.trace, surfaceSnapshot.trace),
  };
  liveMdAnalysisSnapshots.set(runtime, snapshot);
  return snapshot;
}

type LiveMdTraceNumericKey = Exclude<keyof LiveMdLeafAnalysisTrace, "checkedRanges">;

const liveMdTraceNumericKeys: readonly LiveMdTraceNumericKey[] = [
  "blockNodesVisited",
  "codeFenceParserSessionsCreated",
  "codeFenceParserSessionsDeleted",
  "codeFenceParses",
  "codeFenceTreesCreated",
  "codeFenceTreesDeleted",
  "inlineHostsWithoutRanges",
  "inlineRangeGroupsExamined",
  "exactSourceComparisons",
  "exactSourceComparedChars",
  "fallbackCount",
  "fixedPointRounds",
  "inlineParsedChars",
  "inlineParseCalls",
  "inlineParserSessions",
  "languageApplyMs",
  "languageWorkIterations",
  "leavesCollected",
  "legacyFeatureFullQueryCount",
  "projectionRecords",
  "recordsAnalyzed",
  "recordsCollected",
  "recordsMappedIndividually",
  "recordsReused",
  "recordsVisited",
  "cacheIndexQueries",
  "sourceHashCollisions",
  "staleResultDrops",
  "tableCellsParsed",
];

function mergeLiveMdLeafAnalysisTraces(
  primary: LiveMdLeafAnalysisTrace,
  secondary: LiveMdLeafAnalysisTrace,
): LiveMdLeafAnalysisTrace {
  let merged: LiveMdLeafAnalysisTrace = {
    ...primary,
    checkedRanges: mergeDocRanges([...primary.checkedRanges, ...secondary.checkedRanges]),
  };
  let writable = merged as unknown as Record<LiveMdTraceNumericKey, number>;
  for (let key of liveMdTraceNumericKeys) {
    writable[key] = primary[key] + secondary[key];
  }
  return merged;
}

export function __testBuildLiveMdAnalysis(state: EditorState) {
  return liveMdAnalysisSnapshot(state, buildLiveMdAnalysis(state));
}

export function __testBuildCanonicalLiveMdAnalysis(state: EditorState) {
  return buildCanonicalLiveMdAnalysis(state);
}

export function __testLiveMdAnalysis(view: EditorView | { state: EditorState }): LiveMdAnalysis {
  let plugin =
    "plugin" in view && typeof view.plugin == "function" ? view.plugin(liveMdSurfacePlugin) : null;
  let surfaceSnapshot = plugin
    ? { projection: plugin.surface, trace: plugin.surfaceTrace }
    : undefined;
  return liveMdAnalysisSnapshot(view.state, view.state.field(liveMdAnalysisField), surfaceSnapshot);
}

export async function __testFlushLiveMdAnalysis(view: EditorView) {
  for (let index = 0; index < 20; index++) {
    if (!view.state.field(liveMdAnalysisField).pending) return;
    await waitForScheduledTurn();
  }
}

function waitForScheduledTurn() {
  return new Promise<void>((resolve) => {
    let settle = () => setTimeout(resolve, liveMdSchedulerQuietDelay + 5);
    if (typeof globalThis.requestAnimationFrame == "function") {
      globalThis.requestAnimationFrame(settle);
    } else {
      settle();
    }
  });
}

function buildCanonicalLiveMdAnalysis(state: EditorState): LiveMdAnalysis {
  let activeLines = getActiveLines(state);
  let codeFenceLanguages = state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages;
  let tree = syntaxTree(state);
  let markdownParserService = state.facet(liveMdMarkdownParserServiceFacet);
  let markdownAnalysis = markdownParserService ? analyzeLiveMdSourceIslands({ state, tree }) : null;
  let build = buildLegacyLiveMdBuild(
    state,
    activeLines,
    codeFenceLanguages,
    markdownAnalysis,
    tree,
  );
  let projection = finishProjectionLayers(build);
  return {
    activeLines,
    activeSourceRanges: markdownAnalysis?.activeSourceRanges ?? [],
    atomicRanges: projection.atomicRanges,
    decorations: projection.decorations,
    destructiveDecorations: projection.destructiveDecorations,
    directAtomicRanges: projection.direct.atomicRanges,
    directDecorations: projection.direct.decorations,
    directDestructiveDecorations: projection.direct.destructiveDecorations,
    directSourceSafeDecorations: projection.direct.sourceSafeDecorations,
    interactiveDecorations: projection.interactiveDecorations,
    pending: null,
    revision: 0,
    semantic: null,
    semanticTrace: null,
    sourceSafeDecorations: projection.sourceSafeDecorations,
    sourceIslandLeaves: markdownAnalysis?.leaves ?? [],
    surfaceAtomicRanges: projection.surface.atomicRanges,
    surfaceDecorations: projection.surface.decorations,
    surfaceDestructiveDecorations: projection.surface.destructiveDecorations,
    surfaceInteractiveDecorations: projection.surface.interactiveDecorations,
    surfaceSourceSafeDecorations: projection.surface.sourceSafeDecorations,
    trace: build.trace,
    tree,
  };
}

function buildLegacyLiveMdBuild(
  state: EditorState,
  activeLines: Set<number>,
  codeFenceLanguages: CodeFenceLanguageMap,
  markdownAnalysis: LiveMdSourceIslandAnalysis | null,
  tree: ReturnType<typeof syntaxTree>,
  yieldCheck?: () => void,
) {
  let build = createLiveMdBuild({
    activeLines,
    activeSourceRanges: markdownAnalysis?.activeSourceRanges ?? [],
    codeFenceHighlighters: codeFenceHighlighters(state),
    codeFenceLanguages,
    imageSourceResolver: state.facet(liveMdImageSourceResolver),
    linkBaseUrl: state.facet(liveMdLinkBaseUrl),
    markdownFeatures: state.facet(liveMdMarkdownFeatureFacet),
    sourceIslandMode: Boolean(markdownAnalysis),
    state,
    trace: emptyLiveMdLeafAnalysisTrace(),
    yieldCheck,
  });

  let markdownParserService = state.facet(liveMdMarkdownParserServiceFacet);
  if (markdownParserService) {
    withLiveMdMarkdownInlineTrees(markdownParserService, state.doc, tree, (inlineTrees) => {
      processMatches(build, queryLiveMdMatches(tree, inlineTrees), inlineTrees);
    });
    return build;
  }

  processMatches(build, queryLiveMdMatches(tree), []);

  return build;
}

function applyLegacyMarkdownFeatures(
  build: ReturnType<typeof createLiveMdBuild>,
  markdownParserService: LiveMdMarkdownParserService,
  tree: ReturnType<typeof syntaxTree>,
): number {
  if (!hasLegacyDocumentQueryFeature(build.state)) return 0;

  withLiveMdMarkdownInlineTrees(markdownParserService, build.state.doc, tree, (inlineTrees) => {
    applyLiveMdMarkdownFeatures(build, inlineTrees);
  });
  return 1;
}

function hasLegacyDocumentQueryFeature(state: EditorState) {
  return state
    .facet(liveMdMarkdownFeatureFacet)
    .some((feature) => Boolean(feature.query && feature.decorate));
}

function processMatches(
  build: ReturnType<typeof createLiveMdBuild>,
  matches: ReturnType<typeof queryLiveMdMatches>,
  inlineTrees: readonly Tree[],
) {
  let skipped: DocRange[] = [];
  let processed = new Set<string>();
  let tables = new Map<string, CapturedTable>();
  for (let match of matches) {
    collectTable(match, tables);
  }
  for (let match of matches) {
    let root = matchRoot(match);
    if (root && isInsideSkippedRange(root, skipped)) continue;
    if (processLiveMdMatch(build, match, tables, processed, skipped) === false && root) {
      skipped.push({ from: root.from, to: root.to });
    }
  }
  applyLiveMdMarkdownFeatures(build, inlineTrees);
}

function sameRanges(left: readonly DocRange[], right: readonly DocRange[]) {
  if (left.length != right.length) return false;
  for (let index = 0; index < left.length; index++) {
    let leftRange = left[index]!;
    let rightRange = right[index]!;
    if (leftRange.from != rightRange.from || leftRange.to != rightRange.to) return false;
  }
  return true;
}

function sameArrayItems<T>(left: readonly T[], right: readonly T[]) {
  if (left.length != right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] != right[index]) return false;
  }
  return true;
}

function sameSetItems<T>(left: ReadonlySet<T>, right: ReadonlySet<T>) {
  if (left.size != right.size) return false;
  for (let value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function codeFenceLanguagesChanged(startState: EditorState, state: EditorState) {
  return (
    startState.field(codeFenceLanguagesField, false) != state.field(codeFenceLanguagesField, false)
  );
}

function markdownParserServiceChanged(startState: EditorState, state: EditorState) {
  return (
    startState.facet(liveMdMarkdownParserServiceFacet) !=
    state.facet(liveMdMarkdownParserServiceFacet)
  );
}

function markdownFeaturesChanged(startState: EditorState, state: EditorState) {
  return !sameArrayItems(
    startState.facet(liveMdMarkdownFeatureFacet),
    state.facet(liveMdMarkdownFeatureFacet),
  );
}

function codeFenceHighlightersChanged(startState: EditorState, state: EditorState) {
  return !sameArrayItems(codeFenceHighlighters(startState), codeFenceHighlighters(state));
}

function codeFenceHighlighters(state: EditorState): readonly Highlighter[] {
  return (
    state.facet(codeFenceHighlighterFacet) ??
    syntaxHighlighters(state) ??
    defaultCodeFenceHighlighters
  );
}

function getActiveLines(state: EditorState) {
  let lines = new Set<number>();
  for (let range of state.selection.ranges) {
    lines.add(state.doc.lineAt(range.head).number);
  }
  return lines;
}
