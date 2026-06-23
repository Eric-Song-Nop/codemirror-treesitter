import {
  type ChangeDesc,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Range,
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
  type LeafAnalysisCacheTransition,
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
  compileFullDirectLayoutProjection,
  compileIncrementalDirectLayoutProjection,
  compileVisibleSurfaceProjection,
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
  type LiveMdSurfaceProjection,
  type LiveMdSurfaceProjectionState,
} from "./types.js";

const defaultCodeFenceHighlighters = [liveMdDefaultCodeFenceHighlighter] as const;
const liveMdSchedulerQuietDelay = 24;
const liveMdSchedulerMaxDeadlineYields = 2;

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
    private runtime: LiveMdRuntimeState | null = null;
    private surfaceState = emptySurfaceProjectionState();

    constructor(readonly view: EditorView) {
      this.refresh();
    }

    update(update: ViewUpdate) {
      let analysis = update.state.field(liveMdAnalysisField, false);
      if (analysis?.pending) {
        if (update.docChanged) {
          this.mapPendingSurface(update, analysis);
        } else if (this.runtime != analysis) {
          this.clearPendingActiveSurface(analysis);
        }
        return;
      }
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
        this.runtime = null;
        this.surfaceState = emptySurfaceProjectionState();
        return;
      }
      let runtimeChanged = this.runtime != analysis;
      let semanticRevision = surfaceSemanticRevision(analysis);
      if (runtimeChanged || this.surfaceState.semanticRevision != semanticRevision) {
        this.surfaceState = surfaceProjectionStateFromProjection(
          analysis.legacySurface ?? emptySurfaceProjection(),
          semanticRevision,
        );
        this.surfaceTrace = emptyLiveMdLeafAnalysisTrace();
      }

      if (analysis.semantic) {
        let compileRanges = runtimeChanged
          ? visibleRanges
          : subtractDocRanges(visibleRanges, this.surfaceState.compiledRanges);
        if (compileRanges.length) {
          let surfaceTrace = emptyLiveMdLeafAnalysisTrace();
          let compiledSurface = compileRuntimeVisibleSurfaceProjection(
            this.view.state,
            analysis,
            compileRanges,
            surfaceTrace,
          );
          let legacySurface = analysis.legacySurface
            ? filterSurfaceProjectionToRanges(analysis.legacySurface, compileRanges)
            : emptySurfaceProjection();
          this.surfaceState = patchSurfaceProjectionState(
            this.surfaceState,
            mergeSurfaceProjections(compiledSurface, legacySurface),
            compileRanges,
          );
          this.surfaceState = {
            ...this.surfaceState,
            compiledRanges: mergeDocRanges([...this.surfaceState.compiledRanges, ...compileRanges]),
          };
          this.surfaceTrace = mergeLiveMdLeafAnalysisTraces(this.surfaceTrace, surfaceTrace);
        }
      }

      this.runtime = analysis;
      this.publishSurface();
    }

    private mapPendingSurface(update: ViewUpdate, analysis: LiveMdRuntimeState) {
      let pending = analysis.pending;
      if (!pending) return;
      let previous = update.startState.field(liveMdAnalysisField, false);
      let revealRanges = previous
        ? newlyActiveSourceRanges(previous.activeSourceRanges, analysis.activeSourceRanges)
        : [];
      let destructiveSafetyRanges = mergeDocRanges([...pending.safetyRanges, ...revealRanges]);
      let dirtyCompiledRanges = mergeDocRanges([
        ...destructiveSafetyRanges,
        ...pending.interactiveSafetyRanges,
      ]);
      this.surfaceState = {
        atoms: clearRangeSetRanges(
          this.surfaceState.atoms.map(update.changes),
          destructiveSafetyRanges,
        ),
        compiledRanges: subtractDocRanges(
          mapDocRanges(this.surfaceState.compiledRanges, update.changes),
          dirtyCompiledRanges,
        ),
        destructive: clearDecorationRanges(
          this.surfaceState.destructive.map(update.changes),
          destructiveSafetyRanges,
        ),
        interactive: clearDecorationRanges(
          this.surfaceState.interactive.map(update.changes),
          pending.interactiveSafetyRanges,
        ),
        semanticRevision: this.surfaceState.semanticRevision,
        sourceSafe: this.surfaceState.sourceSafe.map(update.changes),
      };
      this.runtime = analysis;
      this.surfaceTrace = emptyLiveMdLeafAnalysisTrace();
      this.surfaceTrace.surfaceMapOnlyUpdates++;
      this.publishSurface();
    }

    private clearPendingActiveSurface(analysis: LiveMdRuntimeState) {
      let previous = this.runtime;
      let revealRanges = previous
        ? newlyActiveSourceRanges(previous.activeSourceRanges, analysis.activeSourceRanges)
        : [];
      if (revealRanges.length) {
        this.surfaceState = {
          ...this.surfaceState,
          atoms: clearRangeSetRanges(this.surfaceState.atoms, revealRanges),
          compiledRanges: subtractDocRanges(this.surfaceState.compiledRanges, revealRanges),
          destructive: clearDecorationRanges(this.surfaceState.destructive, revealRanges),
        };
      }
      this.runtime = analysis;
      this.surfaceTrace = emptyLiveMdLeafAnalysisTrace();
      this.surfaceTrace.surfaceMapOnlyUpdates++;
      this.publishSurface();
    }

    refreshForTest() {
      this.surfaceState = { ...this.surfaceState, compiledRanges: [] };
      this.surfaceTrace = emptyLiveMdLeafAnalysisTrace();
      this.refresh();
    }

    private publishSurface() {
      let surface = surfaceProjectionFromState(this.surfaceState);
      this.surface = surface;
      this.atomicRanges = surface.atomicRanges;
      this.decorations = surface.decorations;
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

function emptySurfaceProjectionState(semanticRevision = -1): LiveMdSurfaceProjectionState {
  return {
    atoms: RangeSet.empty,
    compiledRanges: [],
    destructive: Decoration.none,
    interactive: Decoration.none,
    semanticRevision,
    sourceSafe: Decoration.none,
  };
}

function surfaceProjectionStateFromProjection(
  surface: SurfaceProjection,
  semanticRevision: number,
): LiveMdSurfaceProjectionState {
  return {
    atoms: surface.atomicRanges,
    compiledRanges: [],
    destructive: surface.destructiveDecorations,
    interactive: surface.interactiveDecorations,
    semanticRevision,
    sourceSafe: surface.sourceSafeDecorations,
  };
}

function patchSurfaceProjectionState(
  current: LiveMdSurfaceProjectionState,
  surface: SurfaceProjection,
  ranges: readonly DocRange[],
): LiveMdSurfaceProjectionState {
  return {
    atoms: patchRangeSet(
      current.atoms,
      ranges,
      collectRangeSetRanges(surface.atomicRanges, ranges),
    ),
    compiledRanges: current.compiledRanges,
    destructive: patchRangeSet(
      current.destructive,
      ranges,
      collectRangeSetRanges(surface.destructiveDecorations, ranges),
    ),
    interactive: patchRangeSet(
      current.interactive,
      ranges,
      collectRangeSetRanges(surface.interactiveDecorations, ranges),
    ),
    semanticRevision: current.semanticRevision,
    sourceSafe: patchRangeSet(
      current.sourceSafe,
      ranges,
      collectRangeSetRanges(surface.sourceSafeDecorations, ranges),
    ),
  };
}

function surfaceProjectionFromState(state: LiveMdSurfaceProjectionState): SurfaceProjection {
  return surfaceProjectionFromSets({
    atomicRanges: state.atoms,
    destructiveDecorations: state.destructive,
    interactiveDecorations: state.interactive,
    sourceSafeDecorations: state.sourceSafe,
  });
}

function surfaceProjectionFromSets(input: {
  atomicRanges: RangeSet<RangeValue>;
  destructiveDecorations: DecorationSet;
  interactiveDecorations: DecorationSet;
  sourceSafeDecorations: DecorationSet;
}): SurfaceProjection {
  return {
    atomicRanges: input.atomicRanges,
    decorations: RangeSet.join([
      input.sourceSafeDecorations,
      input.interactiveDecorations,
      input.destructiveDecorations,
    ]),
    destructiveDecorations: input.destructiveDecorations,
    interactiveDecorations: input.interactiveDecorations,
    sourceSafeDecorations: input.sourceSafeDecorations,
  };
}

function filterSurfaceProjectionToRanges(
  surface: LiveMdSurfaceProjection,
  ranges: readonly DocRange[],
): SurfaceProjection {
  return {
    atomicRanges: filterRangeSetToRanges(surface.atomicRanges, ranges),
    decorations: filterRangeSetToRanges(surface.decorations, ranges),
    destructiveDecorations: filterRangeSetToRanges(surface.destructiveDecorations, ranges),
    interactiveDecorations: filterRangeSetToRanges(surface.interactiveDecorations, ranges),
    sourceSafeDecorations: filterRangeSetToRanges(surface.sourceSafeDecorations, ranges),
  };
}

function collectRangeSetRanges<T extends RangeValue>(
  rangeSet: RangeSet<T>,
  ranges: readonly DocRange[],
): Range<T>[] {
  let collected: Range<T>[] = [];
  if (!ranges.length) return collected;
  for (let range of ranges) {
    rangeSet.between(range.from, range.to, (from, to, value) => {
      collected.push(value.range(from, to));
    });
  }
  return collected;
}

function surfaceSemanticRevision(analysis: LiveMdRuntimeState) {
  return analysis.semantic?.revision ?? analysis.revision;
}

function mapDocRanges(ranges: readonly DocRange[], changes: ChangeDesc): readonly DocRange[] {
  return mergeDocRanges(ranges.map((range) => mapRange(range, changes)));
}

function subtractDocRanges(
  ranges: readonly DocRange[],
  removeRanges: readonly DocRange[],
): readonly DocRange[] {
  if (!ranges.length || !removeRanges.length) return ranges;
  let removed = mergeDocRanges(removeRanges);
  let kept: DocRange[] = [];
  for (let range of ranges) {
    let segments: DocRange[] = [range];
    for (let remove of removed) {
      let next: DocRange[] = [];
      for (let segment of segments) {
        if (!docRangesTouch(segment, remove)) {
          next.push(segment);
          continue;
        }
        if (segment.from < remove.from) {
          next.push({ from: segment.from, to: Math.min(segment.to, remove.from) });
        }
        if (remove.to < segment.to) {
          next.push({ from: Math.max(segment.from, remove.to), to: segment.to });
        }
      }
      segments = next;
      if (!segments.length) break;
    }
    kept.push(...segments.filter((segment) => segment.from < segment.to));
  }
  return mergeDocRanges(kept);
}

function liveMdSurfaceVisibleRanges(view: EditorView): readonly DocRange[] {
  let viewport = view.viewport;
  let ranges = view.visibleRanges
    .map((range) => intersectDocRanges(range, viewport))
    .filter((range): range is DocRange => Boolean(range));
  return ranges.length ? ranges : [viewport];
}

function intersectDocRanges(left: DocRange, right: DocRange): DocRange | null {
  let from = Math.max(left.from, right.from);
  let to = Math.min(left.to, right.to);
  return from < to ? { from, to } : null;
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
    legacySurface: baseAnalysis.legacySurface,
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
    if (
      !hasLegacyDocumentQueryFeature(state) &&
      canReuseDirectProjectionForSelectionOnly(
        options.previous,
        state,
        tree,
        options.transaction,
        semanticAnalysis.activeSourceRanges,
      )
    ) {
      return {
        ...options.previous!,
        activeLines,
        activeSourceRanges: semanticAnalysis.activeSourceRanges,
        pending: null,
        semanticTrace: semanticAnalysis.trace,
        sourceIslandLeaves: semanticAnalysis.sourceIslandLeaves,
        trace: semanticAnalysis.trace,
        tree,
      };
    }
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
    let legacyFeatureFullQueryCount = 0;
    let legacySurface: SurfaceProjection | null = null;
    let direct: LiveMdProjectionLayer;
    if (hasLegacyDocumentQueryFeature(state)) {
      let build = createLiveMdBuild(compileInput);
      let projected = projectLeafCacheRecords(
        build,
        semanticAnalysis.semantic.cache,
        liveMdEffectSpecLayerMapper("direct"),
        liveMdRecordMayProduceDirectLayout,
      );
      build.trace.directProjectionRecords += projected;
      build.trace.directProjectionWindows = mergeDocRanges([
        ...build.trace.directProjectionWindows,
        { from: 0, to: state.doc.length },
      ]);
      legacyFeatureFullQueryCount = applyLegacyMarkdownFeatures(build, markdownParserService, tree);
      let projection = finishProjectionLayers(build);
      direct = projection.direct;
      legacySurface = legacyFeatureFullQueryCount ? projection.surface : null;
    } else {
      direct = compileRuntimeDirectLayoutProjection(compileInput, semanticAnalysis, {
        previous: options.previous,
        transaction: options.transaction,
        transitionBase: options.transitionBase,
      });
    }
    let trace = liveMdSemanticTrace(semanticAnalysis.trace, legacyFeatureFullQueryCount);
    let analysis: LiveMdRuntimeState = {
      activeLines,
      activeSourceRanges: semanticAnalysis.activeSourceRanges,
      directAtomicRanges: direct.atomicRanges,
      directDecorations: direct.decorations,
      directDestructiveDecorations: direct.destructiveDecorations,
      directSourceSafeDecorations: direct.sourceSafeDecorations,
      legacySurface,
      pending: null,
      revision: options.revision ?? options.previous?.revision ?? 0,
      semantic: semanticAnalysis.semantic,
      semanticTrace: trace,
      sourceIslandLeaves: semanticAnalysis.sourceIslandLeaves,
      trace,
      tree,
    };
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
    legacySurface: projection.surface,
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

function compileRuntimeDirectLayoutProjection(
  input: LiveMdProjectionCompileInput,
  semanticAnalysis: {
    activeSourceRanges: readonly DocRange[];
    semantic: NonNullable<LiveMdRuntimeState["semantic"]>;
    transition?: LeafAnalysisCacheTransition | null;
  },
  options: {
    previous?: LiveMdRuntimeState;
    transaction?: Transaction;
    transitionBase?: LiveMdPendingAnalysis;
  },
): LiveMdProjectionLayer {
  let patch = directProjectionPatchInput(input.state, semanticAnalysis, options);
  if (patch && options.previous) {
    return compileIncrementalDirectLayoutProjection(input, semanticAnalysis.semantic.cache, {
      changes: patch.changes,
      previous: {
        atomicRanges: options.previous.directAtomicRanges,
        destructiveDecorations: options.previous.directDestructiveDecorations,
        sourceSafeDecorations: options.previous.directSourceSafeDecorations,
      },
      ranges: patch.ranges,
      records: patch.records,
      removeRecordIds: patch.removeRecordIds,
    });
  }
  return compileFullDirectLayoutProjection(input, semanticAnalysis.semantic.cache);
}

function directProjectionPatchInput(
  state: EditorState,
  semanticAnalysis: {
    activeSourceRanges: readonly DocRange[];
    semantic: NonNullable<LiveMdRuntimeState["semantic"]>;
    transition?: LeafAnalysisCacheTransition | null;
  },
  options: {
    previous?: LiveMdRuntimeState;
    transaction?: Transaction;
    transitionBase?: LiveMdPendingAnalysis;
  },
): {
  changes?: ChangeDesc;
  ranges: readonly DocRange[];
  records: readonly LeafAnalysisRecord[];
  removeRecordIds: readonly number[];
} | null {
  let previous = options.previous;
  if (!previous?.semantic) return null;

  let transition = semanticAnalysis.transition;
  if (
    options.transitionBase &&
    transition &&
    !transition.fallback &&
    !runtimeEpochsChanged(options.transitionBase.epochs, runtimeEpochs(state))
  ) {
    let activePatch = activeDirectProjectionPatch({
      changes: options.transitionBase.changes,
      currentActiveSourceRanges: semanticAnalysis.activeSourceRanges,
      currentCache: semanticAnalysis.semantic.cache,
      previous,
    });
    return {
      changes: options.transitionBase.changes,
      ranges: mergeDocRanges([
        ...(transition.mappedOldEffectRanges ?? []),
        ...(transition.newEffectRanges ?? []),
        ...activePatch.ranges,
      ]),
      records: uniqueLeafAnalysisRecords([
        ...(transition.changedRecords ?? []),
        ...activePatch.records,
      ]),
      removeRecordIds: uniqueNumbers([
        ...(transition.changedRecordIds ?? []),
        ...(transition.removedRecordIds ?? []),
        ...activePatch.removeRecordIds,
      ]),
    };
  }

  let transaction = options.transaction;
  if (
    transaction &&
    !transaction.docChanged &&
    previous.semantic.cache == semanticAnalysis.semantic.cache &&
    !directProjectionInputsChanged(transaction.startState, transaction.state)
  ) {
    let activePatch = activeDirectProjectionPatch({
      currentActiveSourceRanges: semanticAnalysis.activeSourceRanges,
      currentCache: semanticAnalysis.semantic.cache,
      previous,
    });
    return {
      ranges: activePatch.ranges,
      records: activePatch.records,
      removeRecordIds: activePatch.removeRecordIds,
    };
  }

  return null;
}

function activeDirectProjectionPatch(input: {
  changes?: ChangeDesc;
  currentActiveSourceRanges: readonly DocRange[];
  currentCache: NonNullable<LiveMdRuntimeState["semantic"]>["cache"];
  previous: LiveMdRuntimeState;
}): {
  ranges: readonly DocRange[];
  records: readonly LeafAnalysisRecord[];
  removeRecordIds: readonly number[];
} {
  let previousActiveRanges = input.changes
    ? input.previous.activeSourceRanges.map((range) => mapRange(range, input.changes!))
    : input.previous.activeSourceRanges;
  if (sameRanges(previousActiveRanges, input.currentActiveSourceRanges)) {
    return { ranges: [], records: [], removeRecordIds: [] };
  }

  let ranges: DocRange[] = [];
  let oldRecords: LeafAnalysisRecord[] = [];
  if (input.previous.semantic) {
    for (let record of findLeafAnalysisRecordsTouchingRanges(
      input.previous.semantic.cache,
      input.previous.activeSourceRanges,
    )) {
      if (!liveMdRecordMayProduceDirectLayout(record)) continue;
      oldRecords.push(record);
      ranges.push(input.changes ? mapRange(record.effectRange, input.changes) : record.effectRange);
    }
  }
  let currentReprojectRanges = mergeDocRanges([
    ...previousActiveRanges,
    ...input.currentActiveSourceRanges,
  ]);
  let records: LeafAnalysisRecord[] = [];
  for (let record of findLeafAnalysisRecordsTouchingRanges(
    input.currentCache,
    currentReprojectRanges,
  )) {
    if (!liveMdRecordMayProduceDirectLayout(record)) continue;
    records.push(record);
    ranges.push(record.effectRange);
  }
  return {
    ranges: mergeDocRanges(ranges),
    records: uniqueLeafAnalysisRecords(records),
    removeRecordIds: uniqueNumbers([
      ...oldRecords.map((record) => record.cacheId),
      ...records.map((record) => record.cacheId),
    ]),
  };
}

function uniqueLeafAnalysisRecords(records: readonly LeafAnalysisRecord[]) {
  let unique: LeafAnalysisRecord[] = [];
  let seen = new Set<number>();
  for (let record of records) {
    if (seen.has(record.cacheId)) continue;
    seen.add(record.cacheId);
    unique.push(record);
  }
  return unique.sort(
    (left, right) => left.range.from - right.range.from || left.range.to - right.range.to,
  );
}

function uniqueNumbers(values: readonly number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function directProjectionInputsChanged(startState: EditorState, state: EditorState) {
  return (
    codeFenceHighlightersChanged(startState, state) ||
    codeFenceLanguagesChanged(startState, state) ||
    markdownFeaturesChanged(startState, state) ||
    startState.facet(liveMdImageSourceResolver) != state.facet(liveMdImageSourceResolver) ||
    startState.facet(liveMdLinkBaseUrl) != state.facet(liveMdLinkBaseUrl)
  );
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
  if (analysis.pending) return emptySurfaceProjection();
  let semantic = analysis.semantic;
  if (!semantic) return emptySurfaceProjection();

  let input = projectionCompileInput(state, analysis.activeLines, analysis.activeSourceRanges, {
    sourceIslandMode: true,
    trace,
  });
  return compileVisibleSurfaceProjection(input, semantic.cache, ranges, {
    codeFenceHighlights: true,
  });
}

function visibleLegacySurface(
  analysis: LiveMdRuntimeState,
  visibleRanges: readonly DocRange[],
): SurfaceProjection {
  if (!analysis.legacySurface || !visibleRanges.length) return emptySurfaceProjection();
  return surfaceProjectionFromSets({
    atomicRanges: filterRangeSetToRanges(analysis.legacySurface.atomicRanges, visibleRanges),
    destructiveDecorations: filterRangeSetToRanges(
      analysis.legacySurface.destructiveDecorations,
      visibleRanges,
    ),
    interactiveDecorations: filterRangeSetToRanges(
      analysis.legacySurface.interactiveDecorations,
      visibleRanges,
    ),
    sourceSafeDecorations: filterRangeSetToRanges(
      analysis.legacySurface.sourceSafeDecorations,
      visibleRanges,
    ),
  });
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
      transition: null,
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
        transition,
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
      transition: null,
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
    transition,
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

function canReuseDirectProjectionForSelectionOnly(
  previous: LiveMdRuntimeState | undefined,
  state: EditorState,
  tree: Tree,
  transaction: Transaction | undefined,
  activeSourceRanges: readonly DocRange[],
) {
  if (
    !previous?.semantic ||
    !transaction ||
    transaction.docChanged ||
    tree != previous.tree ||
    markdownParserServiceChanged(transaction.startState, state) ||
    directProjectionInputsChanged(transaction.startState, state)
  ) {
    return false;
  }
  let touchedActiveRanges = mergeDocRanges([...previous.activeSourceRanges, ...activeSourceRanges]);
  if (!touchedActiveRanges.length) return true;
  return findLeafAnalysisRecordsTouchingRanges(previous.semantic.cache, touchedActiveRanges).every(
    (record) => !liveMdRecordMayProduceDirectLayout(record),
  );
}

function compileRuntimeSurfaceSnapshot(
  state: EditorState,
  runtime: LiveMdRuntimeState,
): SurfaceProjectionSnapshot {
  let ranges = state.doc.length ? [{ from: 0, to: state.doc.length }] : [];
  let trace = emptyLiveMdLeafAnalysisTrace();
  let projection = mergeSurfaceProjections(
    compileRuntimeVisibleSurfaceProjection(state, runtime, ranges, trace),
    visibleLegacySurface(runtime, ranges),
  );
  return { projection, trace };
}

const liveMdFullAnalysisSnapshots = new WeakMap<LiveMdRuntimeState, LiveMdAnalysis>();
const liveMdSurfaceAnalysisSnapshots = new WeakMap<
  LiveMdRuntimeState,
  WeakMap<SurfaceProjection, LiveMdAnalysis>
>();

function liveMdAnalysisSnapshot(
  state: EditorState,
  runtime: LiveMdRuntimeState,
  surfaceSnapshot?: SurfaceProjectionSnapshot,
): LiveMdAnalysis {
  let explicitSurfaceSnapshot = Boolean(surfaceSnapshot);
  if (explicitSurfaceSnapshot) {
    let surfaceSnapshots = liveMdSurfaceAnalysisSnapshots.get(runtime);
    let cached = surfaceSnapshots?.get(surfaceSnapshot!.projection);
    if (cached) return cached;
  } else {
    let cached = liveMdFullAnalysisSnapshots.get(runtime);
    if (cached) return cached;
  }
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
  if (explicitSurfaceSnapshot) {
    let surfaceSnapshots = liveMdSurfaceAnalysisSnapshots.get(runtime);
    if (!surfaceSnapshots) {
      surfaceSnapshots = new WeakMap();
      liveMdSurfaceAnalysisSnapshots.set(runtime, surfaceSnapshots);
    }
    surfaceSnapshots.set(surfaceSnapshot.projection, snapshot);
  } else {
    liveMdFullAnalysisSnapshots.set(runtime, snapshot);
  }
  return snapshot;
}

type LiveMdTraceNumericKey = {
  [Key in keyof LiveMdLeafAnalysisTrace]: LiveMdLeafAnalysisTrace[Key] extends number ? Key : never;
}[keyof LiveMdLeafAnalysisTrace];

const liveMdTraceNumericKeyMap = {
  blockNodesVisited: true,
  codeFenceParserSessionsCreated: true,
  codeFenceParserSessionsDeleted: true,
  codeFenceParses: true,
  codeFenceTreesCreated: true,
  codeFenceTreesDeleted: true,
  inlineHostsWithoutRanges: true,
  inlineRangeGroupsExamined: true,
  exactSourceComparisons: true,
  exactSourceComparedChars: true,
  fallbackCount: true,
  fixedPointRounds: true,
  inlineParsedChars: true,
  inlineParseCalls: true,
  inlineParserSessions: true,
  languageApplyMs: true,
  languageWorkIterations: true,
  leavesCollected: true,
  legacyFeatureFullQueryCount: true,
  directProjectionRecords: true,
  projectionRecords: true,
  recordsAnalyzed: true,
  cacheFullMaterializations: true,
  recordsCollected: true,
  recordsMappedIndividually: true,
  recordsReused: true,
  recordsVisited: true,
  cacheIndexCallbacks: true,
  cacheIndexQueries: true,
  heavyRenderStarts: true,
  recordIndexQueries: true,
  safetyIndexQueries: true,
  sourceHashCollisions: true,
  staleResultDrops: true,
  surfaceCompileCalls: true,
  surfaceDescriptorsMapped: true,
  surfaceMapOnlyUpdates: true,
  surfaceRecordsVisited: true,
  tableCellsParsed: true,
  widgetConstructions: true,
} satisfies Record<LiveMdTraceNumericKey, true>;

const liveMdTraceNumericKeys = Object.keys(liveMdTraceNumericKeyMap) as LiveMdTraceNumericKey[];

function mergeLiveMdLeafAnalysisTraces(
  primary: LiveMdLeafAnalysisTrace,
  secondary: LiveMdLeafAnalysisTrace,
): LiveMdLeafAnalysisTrace {
  let merged: LiveMdLeafAnalysisTrace = {
    ...primary,
    checkedRanges: mergeDocRanges([...primary.checkedRanges, ...secondary.checkedRanges]),
    directProjectionWindows: mergeDocRanges([
      ...primary.directProjectionWindows,
      ...secondary.directProjectionWindows,
    ]),
    surfaceCompileRanges: mergeDocRanges([
      ...primary.surfaceCompileRanges,
      ...secondary.surfaceCompileRanges,
    ]),
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

export function __testRefreshLiveMdSurface(view: EditorView) {
  view.plugin(liveMdSurfacePlugin)?.refreshForTest();
}

export async function __testFlushLiveMdAnalysis(view: EditorView) {
  for (let index = 0; index < 120; index++) {
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
    legacySurface: projection.surface,
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
