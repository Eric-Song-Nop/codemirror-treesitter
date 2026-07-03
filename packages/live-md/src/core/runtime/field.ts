import {
  type ChangeDesc,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  mergeDocRanges,
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
  createLeafAnalysisCache,
  disposeLeafAnalysisResumeState,
  emptyLeafAnalysisCacheTrace,
  findLeafAnalysisRecordsTouchingRanges,
  leafAnalysisCacheRangesInDoc,
  takeLeafAnalysisResumeStateFromYield,
  materializeLeafAnalysisCacheRecords,
  rekeyLeafAnalysisCache,
  transitionLeafAnalysisCacheLocal,
  transitionLeafAnalysisCache,
  type LeafAnalysisCacheTransition,
  type LeafAnalysisResumeState,
} from "../analysis/markdown-leaf-cache.js";
import {
  analyzeMarkdownLeafSemantics,
  liveMdRendererVersion,
  sameLiveMdRenderKeyContext,
  type LiveMdRenderKeyContext,
} from "../analysis/markdown-leaf-analysis.js";
import {
  activeMarkdownSourceRanges,
  findSourceIslandLeaf,
  sourceIslandIndexFromLeaves,
  sourceIslandLeavesInDoc,
  sourceIslandLeavesFromLeafAnalysisRecords,
} from "../analysis/markdown-source-islands.js";
import {
  type DocRange,
  emptyLiveMdLeafAnalysisTrace,
  type LiveMdLeafAnalysisTrace,
} from "../analysis/types.js";
import {
  clampRangeToDoc,
  countLines,
  isBroadContainerSyntaxRange,
  lineRangeFor,
  mapInclusiveRange,
  mapRange,
  rangesEqual,
  rangesTouchInclusive,
  rangesTouchPoint,
  subtractRanges,
  textChangeContextRanges,
} from "../analysis/ranges.js";
import { liveMdMarkdownFeatureFacet } from "../features.js";
import { liveMdImageSourceResolver } from "../images.js";
import {
  codeFenceHighlighterFacet,
  codeFenceLanguagesField,
  emptyCodeFenceLanguages,
  liveMdMarkdownParserServiceFacet,
  liveMdDefaultCodeFenceHighlighter,
  type CodeFenceLanguageMap,
  type LiveMdMarkdownParserService,
} from "../languages.js";
import { liveMdLinkBaseUrl } from "../links.js";
import {
  compileFullDirectLayoutProjection,
  compileProjectionLayersFromCache,
  compileIncrementalDirectLayoutProjection,
  compileVisibleSurfaceProjection,
  type LiveMdProjectionCompileInput,
} from "../projection/compilers.js";
import { type LiveMdProjectionLayer } from "../projection/emit.js";
import { liveMdRecordMayProduceDirectLayout } from "../projection/project-leaf.js";
import {
  type LiveMdAnalysis,
  type LiveMdPendingAnalysis,
  type LiveMdPendingEditSurface,
  type LiveMdRuntimeState,
  type LiveMdRuntimeEpochs,
  type LiveMdSemanticTrace,
  type LiveMdSurfaceProjectionState,
} from "./types.js";
import { liveMdCompositeEpoch, liveMdValueEpoch } from "./epochs.js";
import { taskToggleFastPath } from "./fast-paths.js";
import {
  clearInteractiveProjectionSets,
  emptyProjectionSets,
  joinProjectionSets as joinProjectionSetDecorations,
  mapProjectionSets,
  projectionLayerFromSets,
  projectionSetsFromLayer,
  replaceProjectionSets,
  restoreProjectionSets,
  revealProjectionSets,
} from "./projection-state.js";
import { createLiveMdRenderCache, type LiveMdRenderCache } from "./render-cache.js";

const defaultCodeFenceHighlighters = [liveMdDefaultCodeFenceHighlighter] as const;
const liveMdSchedulerQuietDelay = 24;
const liveMdSchedulerMaxDeadlineYields = 2;
const liveMdSchedulerMaxInputYields = 5;

type BuildLiveMdAnalysisOptions = {
  activeSourceRanges?: readonly DocRange[] | null;
  leafAnalysisResume?: LeafAnalysisResumeState | null;
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

type LiveMdPendingSurfaceBase = {
  runtime: LiveMdRuntimeState;
  state: LiveMdSurfaceProjectionState;
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
      if (transaction.isUserEvent("input.task") && value.semantic && !value.pending) {
        let trace = pendingInputTrace(transaction);
        let activeLines = getActiveLines(transaction.state);
        let activeSourceRanges = activeMarkdownSourceRanges(
          transaction.state,
          value.sourceIslandLeaves,
        );
        let tree = syntaxTree(transaction.state);
        let fast = taskToggleFastPath({
          activeLines,
          activeSourceRanges,
          compileInput: projectionCompileInput(transaction.state, activeLines, activeSourceRanges, {
            renderCache: value.renderCache,
            sourceIslandMode: true,
            trace,
          }),
          transaction,
          tree,
          value,
        });
        if (fast) return fast;
      }
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
        ? activeSourceRanges != null && rangesEqual(activeSourceRanges, value.activeSourceRanges)
        : activeLinesStable;
    if (
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
      EditorView.decorations.from(field, (analysis) =>
        joinProjectionSetDecorations(analysis.direct),
      ),
      EditorView.atomicRanges.of(
        (view) => view.state.field(field, false)?.direct.atomicRanges ?? RangeSet.empty,
      ),
    ];
  },
});

const liveMdSchedulerPlugin = ViewPlugin.fromClass(
  class LiveMdSchedulerPlugin {
    private destroyed = false;
    private lastCommitWasCheap = false;
    private resume: LeafAnalysisResumeState | null = null;
    private resumeEpochs: LiveMdRuntimeEpochs | null = null;
    private scheduled: LiveMdScheduledWork | null = null;
    private yieldedRevision = -1;
    private deadlineYieldCount = 0;
    private inputYieldCount = 0;

    constructor(readonly view: EditorView) {
      this.scheduleIfPending();
    }

    update(update: ViewUpdate) {
      this.noteCommittedAnalysis(update);
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
      this.clearResume();
    }

    private scheduleIfPending() {
      let pending = this.view.state.field(liveMdAnalysisField).pending;
      if (!pending) {
        this.scheduled?.cancel();
        this.scheduled = null;
        this.clearResume();
        this.resetYieldCount();
        return;
      }
      if (this.yieldedRevision != pending.revision) {
        this.clearResume();
        this.resetYieldCount(pending.revision);
      }
      let currentEpochs = runtimeEpochs(this.view.state);
      if (this.resumeEpochs && runtimeEpochsChanged(this.resumeEpochs, currentEpochs)) {
        this.clearResume();
      }
      if (this.scheduled?.revision == pending.revision) return;
      this.scheduled?.cancel();
      this.scheduled = scheduleLiveMdWork(
        pending.revision,
        (deadline) => this.runScheduled(pending.revision, deadline),
        {
          allowDeadlineYield: this.deadlineYieldCount < liveMdSchedulerMaxDeadlineYields,
          quietDelay: this.lastCommitWasCheap ? 0 : liveMdSchedulerQuietDelay,
          shouldYieldForInput: () => this.shouldYieldForInput(pending.revision),
        },
      );
    }

    private runScheduled(revision: number, deadline?: IdleDeadline) {
      this.scheduled = null;
      if (this.destroyed) return;
      let current = this.view.state.field(liveMdAnalysisField, false);
      let pending = current?.pending;
      if (!pending || pending.revision != revision) {
        this.clearResume();
        return;
      }
      if (!syntaxTreeAvailable(this.view.state, this.view.state.doc.length)) {
        this.scheduleIfPending();
        return;
      }

      let yieldCheck = scheduledYieldCheck(
        deadline,
        this.deadlineYieldCount < liveMdSchedulerMaxDeadlineYields,
        () => this.shouldYieldForInput(revision),
      );
      let analysis: LiveMdRuntimeState;
      try {
        yieldCheck();
        analysis = buildLiveMdAnalysis(this.view.state, getActiveLines(this.view.state), {
          leafAnalysisResume: this.resume?.revision == revision ? this.resume : null,
          previous: pending.baseAnalysis,
          revision,
          transitionBase: pending,
          tree: syntaxTree(this.view.state),
          yieldCheck,
        });
        this.clearResume();
      } catch (error) {
        if (error instanceof LiveMdScheduledYield) {
          let resume = takeLeafAnalysisResumeStateFromYield(error);
          if (resume?.revision == revision) {
            this.replaceResume(resume);
          } else if (resume) {
            disposeLeafAnalysisResumeState(resume);
          }
          if (error.reason == "deadline") this.deadlineYieldCount++;
          this.scheduleIfPending();
          return;
        }
        throw error;
      }
      this.resetYieldCount();
      this.clearResume();
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
      this.deadlineYieldCount = 0;
      this.inputYieldCount = 0;
    }

    private replaceResume(resume: LeafAnalysisResumeState) {
      if (this.resume == resume) return;
      this.clearResume();
      this.resume = resume;
      this.resumeEpochs = runtimeEpochs(this.view.state);
    }

    private clearResume() {
      disposeLeafAnalysisResumeState(this.resume);
      this.resume = null;
      this.resumeEpochs = null;
    }

    private shouldYieldForInput(revision: number) {
      if (this.yieldedRevision != revision) this.resetYieldCount(revision);
      if (this.inputYieldCount >= liveMdSchedulerMaxInputYields) return false;
      this.inputYieldCount++;
      return true;
    }

    private noteCommittedAnalysis(update: ViewUpdate) {
      let previous = update.startState.field(liveMdAnalysisField, false);
      let current = update.state.field(liveMdAnalysisField, false);
      if (previous == current || !previous?.pending || !current || current.pending) return;
      if (current.revision != previous.pending.revision) return;
      this.lastCommitWasCheap = liveMdCommitWasCheap(current);
    }
  },
);

const liveMdSurfacePlugin = ViewPlugin.fromClass(
  class LiveMdSurfacePlugin {
    atomicRanges = RangeSet.empty;
    decorations: DecorationSet = Decoration.none;
    surface = emptySurfaceProjection();
    surfaceTrace = emptyLiveMdLeafAnalysisTrace();
    private pendingSurfaceBase: LiveMdPendingSurfaceBase | null = null;
    private runtime: LiveMdRuntimeState | null = null;
    private lastScrollDirection: -1 | 0 | 1 = 0;
    private lastViewportFrom: number | null = null;
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
      let visibleRanges = liveMdSurfaceVisibleRanges(this.view, this.surfaceReadAheadDirection());
      if (!analysis) {
        this.atomicRanges = RangeSet.empty;
        this.decorations = Decoration.none;
        this.surface = emptySurfaceProjection();
        this.surfaceTrace = emptyLiveMdLeafAnalysisTrace();
        this.pendingSurfaceBase = null;
        this.runtime = null;
        this.surfaceState = emptySurfaceProjectionState();
        return;
      }
      let runtimeChanged = this.runtime != analysis;
      let semanticRevision = surfaceSemanticRevision(analysis);
      let surfaceInvalidationRanges =
        runtimeChanged && analysis.surfaceInvalidationRanges.length
          ? analysis.surfaceInvalidationRanges
          : [];
      let partialSurfaceInvalidation =
        surfaceInvalidationRanges.length > 0 &&
        this.runtime != null &&
        this.surfaceState.semanticRevision >= 0;
      if (runtimeChanged || this.surfaceState.semanticRevision != semanticRevision) {
        if (partialSurfaceInvalidation) {
          this.surfaceState = invalidateSurfaceProjectionState(
            this.surfaceState,
            surfaceInvalidationRanges,
            semanticRevision,
          );
        } else {
          this.surfaceState = emptySurfaceProjectionState(semanticRevision);
          this.surfaceTrace = emptyLiveMdLeafAnalysisTrace();
        }
      }

      if (analysis.semantic) {
        let compileRanges = subtractRanges(visibleRanges, this.surfaceState.compiledRanges);
        if (compileRanges.length) {
          let surfaceTrace = emptyLiveMdLeafAnalysisTrace();
          let compiledSurface = compileRuntimeVisibleSurfaceProjection(
            this.view.state,
            analysis,
            compileRanges,
            surfaceTrace,
          );
          this.surfaceState = patchSurfaceProjectionState(
            this.surfaceState,
            compiledSurface,
            compileRanges,
          );
          this.surfaceState = {
            ...this.surfaceState,
            compiledRanges: mergeDocRanges([...this.surfaceState.compiledRanges, ...compileRanges]),
          };
          this.surfaceTrace = mergeLiveMdLeafAnalysisTraces(this.surfaceTrace, surfaceTrace);
        }
      }

      this.surfaceState = evictSurfaceOutside(this.surfaceState, surfaceKeepWindow(this.view));
      this.runtime = analysis;
      this.pendingSurfaceBase = null;
      this.publishSurface();
    }

    private surfaceReadAheadDirection() {
      let viewportFrom = this.view.viewport.from;
      if (this.lastViewportFrom != null && this.lastViewportFrom != viewportFrom) {
        this.lastScrollDirection = this.lastViewportFrom < viewportFrom ? 1 : -1;
      }
      this.lastViewportFrom = viewportFrom;
      return this.lastScrollDirection;
    }

    private mapPendingSurface(update: ViewUpdate, analysis: LiveMdRuntimeState) {
      let pending = analysis.pending;
      if (!pending) return;
      let editSurfaceRanges = pending.editSurface.ranges;
      let interactiveSafetyRanges = pending.interactiveSafetyRanges;
      let restoreRanges = pending.editSurface.restoreRanges;
      let baseSurfaceState = this.pendingSurfaceBaseState(pending);
      let mappedBase = mapProjectionSets(baseSurfaceState, pending.changes, []);
      let mappedCurrent = mapProjectionSets(this.surfaceState, update.changes, []);
      let restored = restoreProjectionSets(mappedCurrent, mappedBase, restoreRanges);
      let revealed = revealProjectionSets(restored, editSurfaceRanges);
      let sets = clearInteractiveProjectionSets(revealed, interactiveSafetyRanges);
      this.surfaceState = {
        ...sets,
        compiledRanges: subtractRanges(
          mapDocRanges(this.surfaceState.compiledRanges, update.changes),
          editSurfaceRanges,
        ),
        semanticRevision: this.surfaceState.semanticRevision,
      };
      this.runtime = analysis;
      this.surfaceTrace = emptyLiveMdLeafAnalysisTrace();
      this.surfaceTrace.surfaceMapOnlyUpdates++;
      this.publishSurface();
    }

    private pendingSurfaceBaseState(pending: LiveMdPendingAnalysis) {
      if (this.pendingSurfaceBase?.runtime != pending.baseAnalysis) {
        // PR-7 will collapse this direct/surface duplication into one
        // projection-state restore path. Until then, surface restore uses the
        // plugin's compiled snapshot and may inherit active-source holes that
        // are cosmetic and commit-healed.
        this.pendingSurfaceBase = {
          runtime: pending.baseAnalysis,
          state: this.surfaceState,
        };
      }
      return this.pendingSurfaceBase.state;
    }

    private clearPendingActiveSurface(analysis: LiveMdRuntimeState) {
      let previous = this.runtime;
      let revealRanges = previous
        ? newlyActiveSourceRanges(previous.activeSourceRanges, analysis.activeSourceRanges)
        : [];
      if (revealRanges.length) {
        let sets = clearInteractiveProjectionSets(
          revealProjectionSets(this.surfaceState, revealRanges),
          revealRanges,
        );
        this.surfaceState = {
          ...this.surfaceState,
          ...sets,
          compiledRanges: subtractRanges(this.surfaceState.compiledRanges, revealRanges),
        };
      }
      this.runtime = analysis;
      this.surfaceTrace = emptyLiveMdLeafAnalysisTrace();
      this.surfaceTrace.surfaceMapOnlyUpdates++;
      this.publishSurface();
    }

    refreshForTest() {
      this.surfaceState = emptySurfaceProjectionState(this.surfaceState.semanticRevision);
      this.surfaceTrace = emptyLiveMdLeafAnalysisTrace();
      this.refresh();
    }

    refreshPreservingStateForTest() {
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
    ...emptyProjectionSets(),
    compiledRanges: [],
    semanticRevision,
  };
}

function patchSurfaceProjectionState(
  current: LiveMdSurfaceProjectionState,
  surface: SurfaceProjection,
  ranges: readonly DocRange[],
): LiveMdSurfaceProjectionState {
  let patched = replaceProjectionSets(current, ranges, projectionSetsFromLayer(surface));
  return {
    ...patched,
    compiledRanges: current.compiledRanges,
    semanticRevision: current.semanticRevision,
  };
}

function invalidateSurfaceProjectionState(
  current: LiveMdSurfaceProjectionState,
  ranges: readonly DocRange[],
  semanticRevision: number,
): LiveMdSurfaceProjectionState {
  let cleared = replaceProjectionSets(current, ranges, emptyProjectionSets());
  return {
    ...cleared,
    compiledRanges: subtractRanges(current.compiledRanges, ranges),
    semanticRevision,
  };
}

function evictSurfaceOutside(
  current: LiveMdSurfaceProjectionState,
  keepWindow: DocRange,
): LiveMdSurfaceProjectionState {
  let evictedRanges = subtractRanges(current.compiledRanges, [keepWindow]);
  if (!evictedRanges.length) return current;
  let cleared = replaceProjectionSets(current, evictedRanges, emptyProjectionSets());
  return {
    ...cleared,
    compiledRanges: subtractRanges(current.compiledRanges, evictedRanges),
    semanticRevision: current.semanticRevision,
  };
}

function surfaceProjectionFromState(state: LiveMdSurfaceProjectionState): SurfaceProjection {
  return projectionLayerFromSets(state);
}

function surfaceSemanticRevision(analysis: LiveMdRuntimeState) {
  return analysis.semantic?.revision ?? analysis.revision;
}

function mapDocRanges(ranges: readonly DocRange[], changes: ChangeDesc): readonly DocRange[] {
  return mergeDocRanges(ranges.map((range) => mapRange(range, changes)));
}

function liveMdSurfaceVisibleRanges(
  view: EditorView,
  readAheadDirection: -1 | 0 | 1 = 0,
): readonly DocRange[] {
  let viewport = view.viewport;
  let ranges = view.visibleRanges
    .map((range) => intersectDocRanges(range, viewport))
    .filter((range): range is DocRange => Boolean(range));
  let visibleRanges = ranges.length ? ranges : [viewport];
  let readAhead = surfaceReadAheadRange(view, readAheadDirection);
  return readAhead ? mergeDocRanges([...visibleRanges, readAhead]) : visibleRanges;
}

function surfaceKeepWindow(view: EditorView): DocRange {
  let viewport = view.viewport;
  let viewportSpan = Math.max(1, viewport.to - viewport.from);
  return clampRangeToDoc(
    {
      from: viewport.from - 2 * viewportSpan,
      to: viewport.to + 2 * viewportSpan,
    },
    view.state.doc.length,
  );
}

function surfaceReadAheadRange(view: EditorView, readAheadDirection: -1 | 0 | 1): DocRange | null {
  if (!readAheadDirection) return null;
  let viewport = view.viewport;
  let readAhead = Math.max(1, Math.ceil((viewport.to - viewport.from) / 2));
  let range: DocRange;
  if (readAheadDirection > 0) {
    range = clampRangeToDoc(
      { from: viewport.to, to: viewport.to + readAhead },
      view.state.doc.length,
    );
  } else {
    range = clampRangeToDoc(
      {
        from: viewport.from - readAhead,
        to: viewport.from,
      },
      view.state.doc.length,
    );
  }
  return range.from < range.to ? range : null;
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

type LiveMdScheduleWorkOptions = {
  allowDeadlineYield?: boolean;
  quietDelay?: number;
  shouldYieldForInput?: () => boolean;
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
  let editSurface = pendingEditSurface(
    previousPending,
    baseAnalysis,
    transaction,
    changes,
    syntaxChangedRanges,
  );
  let safetyRanges = editSurface.ranges;
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
    editSurface,
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
  let mappedBaseDirect = mapProjectionSets(baseAnalysis.direct, changes, []);
  let mappedDirect = mapProjectionSets(value.direct, transaction.changes, []);
  let restoredDirect = restoreProjectionSets(
    mappedDirect,
    mappedBaseDirect,
    editSurface.restoreRanges,
  );
  let direct = revealProjectionSets(restoredDirect, editSurface.ranges);
  let trace = pendingInputTrace(transaction);
  trace.editSurfaceRanges = editSurface.ranges;
  trace.editSurfaceLines = countLines(transaction.state.doc, editSurface.ranges);
  return {
    activeLines,
    activeSourceRanges,
    direct,
    pending,
    renderCache: value.renderCache,
    renderKeyContext: baseAnalysis.renderKeyContext,
    revision,
    semantic: baseAnalysis.semantic,
    semanticTrace: baseAnalysis.semantic ? emptyLeafAnalysisCacheTrace() : null,
    surfaceInvalidationRanges: [],
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
    rangesEqual(activeSourceRanges, value.activeSourceRanges)
  ) {
    return value;
  }
  let direct = revealProjectionSets(value.direct, revealRanges);
  return {
    ...value,
    activeLines,
    activeSourceRanges,
    direct,
    surfaceInvalidationRanges: [],
    trace: pending ? value.trace : emptyLiveMdLeafAnalysisTrace(),
  };
}

function pendingEditSurface(
  previousPending: LiveMdPendingAnalysis | null,
  baseAnalysis: LiveMdRuntimeState,
  transaction: Transaction,
  changes: ChangeDesc,
  syntaxChangedRanges: readonly DocRange[],
): LiveMdPendingEditSurface {
  let state = transaction.state;
  let changedRanges = changedRangePairs(state, transaction.changes);
  let textContextRanges = textChangeContextRanges(
    transaction.startState.doc,
    state.doc,
    transaction.changes,
  );
  let changedLineRanges = mergeDocRanges(changedRanges.map((range) => range.newLineRange));
  let revealChangedRanges = transactionRevealsSource(transaction)
    ? changedRanges.filter((range) => changeIsSelectionLocal(state, range.newRange))
    : [];
  let revealChangedLineRanges = mergeDocRanges(
    revealChangedRanges.map((range) => range.newLineRange),
  );
  let revealOldChangedRanges = revealChangedRanges.map((range) => range.oldRange);
  let currentSelectionLineRanges = selectionPhysicalLineRanges(state);
  let selectionLineRanges = currentSelectionLineRanges.filter((range) =>
    revealChangedLineRanges.some((changed) => rangesTouchPoint(range, changed)),
  );
  let previousRanges =
    previousPending?.editSurface.ranges.map((range) => mapRange(range, transaction.changes)) ?? [];
  let restoreRanges = mergeDocRanges(
    previousRanges
      .filter(
        (range) =>
          !changedLineRanges.some((changed) => rangesTouchPoint(range, changed)) &&
          !currentSelectionLineRanges.some((line) => rangesTouchPoint(range, line)),
      )
      .map((range) => clampRangeToDoc(range, state.doc.length)),
  );
  let retainedPreviousRanges = subtractRanges(previousRanges, restoreRanges);
  let touchedRevealRanges = touchedRecordRevealRanges(
    baseAnalysis,
    state,
    changes,
    revealOldChangedRanges,
  );
  let syntaxLineRanges = syntaxChangedRanges
    .filter((range) => !isBroadContainerSyntaxRange(range, textContextRanges, state.doc.length))
    .map((range) => lineRangeFor(state.doc, range.from, range.to))
    .filter((range) => revealChangedLineRanges.some((changed) => rangesTouchPoint(range, changed)));
  let ranges = mergeDocRanges(
    [
      ...revealChangedLineRanges,
      ...selectionLineRanges,
      ...retainedPreviousRanges,
      ...touchedRevealRanges,
      ...syntaxLineRanges,
    ].map((range) => clampRangeToDoc(range, state.doc.length)),
  );
  return {
    ranges,
    restoreRanges,
  };
}

function selectionPhysicalLineRanges(state: EditorState): readonly DocRange[] {
  return mergeDocRanges(
    state.selection.ranges.map((range) => lineRangeFor(state.doc, range.from, range.to)),
  );
}

function touchedRecordRevealRanges(
  baseAnalysis: LiveMdRuntimeState,
  state: EditorState,
  changes: ChangeDesc,
  oldChangedRanges = changedOldRanges(changes),
): readonly DocRange[] {
  let ranges: DocRange[] = [];

  if (baseAnalysis.semantic) {
    for (let record of findLeafAnalysisRecordsTouchingRanges(
      baseAnalysis.semantic.cache,
      oldChangedRanges,
    )) {
      if (!record.revealRange) continue;
      if (!recordSourceTouchedByRanges(record, oldChangedRanges)) continue;
      if (!recordRevealRangeTouchedByRanges(record.revealRange, oldChangedRanges)) continue;
      ranges.push(mapRange(record.revealRange, changes));
    }
  }

  return mergeDocRanges(ranges.map((range) => clampRangeToDoc(range, state.doc.length)));
}

function recordSourceTouchedByRanges(record: LeafAnalysisRecord, ranges: readonly DocRange[]) {
  let cacheSourceRange = record.cacheSourceRange ?? record.sourceRange;
  return ranges.some(
    (range) =>
      rangesTouchPoint(record.sourceRange, range) || rangesTouchPoint(cacheSourceRange, range),
  );
}

function recordRevealRangeTouchedByRanges(revealRange: DocRange, ranges: readonly DocRange[]) {
  return ranges.some((range) => rangesTouchPoint(revealRange, range));
}

function sourceInteractiveSafetyRanges(
  baseAnalysis: LiveMdRuntimeState,
  state: EditorState,
  changes: ChangeDesc,
  fallbackRanges: readonly DocRange[],
): readonly DocRange[] {
  if (!baseAnalysis.semantic) return fallbackRanges;

  let oldChangedRanges = changedOldRanges(changes);
  let ranges: DocRange[] = [...fallbackRanges];
  for (let record of findLeafAnalysisRecordsTouchingRanges(
    baseAnalysis.semantic.cache,
    oldChangedRanges,
  )) {
    for (let descriptor of record.analysis.descriptors) {
      if (!isDirtyLinkDescriptor(descriptor, oldChangedRanges, record.sourceRange.from)) continue;
      ranges.push(mapRange(offsetDocRange(descriptor.range, record.sourceRange.from), changes));
    }
  }

  return mergeDocRanges(ranges.map((range) => clampRangeToDoc(range, state.doc.length)));
}

function isDirtyLinkDescriptor(
  descriptor: LiveMdDescriptor,
  oldChangedRanges: readonly DocRange[],
  sourceOffset: number,
): descriptor is Extract<LiveMdDescriptor, { kind: "linkMark" }> {
  if (descriptor.kind != "linkMark") return false;
  let sourceRange = offsetDocRange(descriptor.sourceRange, sourceOffset);
  return oldChangedRanges.some((range) => rangesTouchPoint(sourceRange, range));
}

function changedOldRanges(changes: ChangeDesc): DocRange[] {
  let ranges: DocRange[] = [];
  changes.iterChangedRanges((fromA, toA) => {
    ranges.push({ from: fromA, to: toA });
  }, true);
  return ranges;
}

function changedRangePairs(
  state: EditorState,
  changes: ChangeDesc,
): {
  newRange: DocRange;
  newLineRange: DocRange;
  oldRange: DocRange;
}[] {
  let ranges: { newRange: DocRange; newLineRange: DocRange; oldRange: DocRange }[] = [];
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    ranges.push({
      newRange: { from: fromB, to: toB },
      newLineRange: lineRangeFor(state.doc, fromB, toB),
      oldRange: { from: _fromA, to: _toA },
    });
  }, true);
  return ranges;
}

function transactionRevealsSource(transaction: Transaction) {
  return (
    transaction.annotation(Transaction.remote) !== true &&
    transaction.annotation(Transaction.addToHistory) !== false
  );
}

function changeIsSelectionLocal(state: EditorState, changedRange: DocRange) {
  return state.selection.ranges.some((range) =>
    rangesTouchInclusive({ from: range.from, to: range.to }, changedRange),
  );
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

function liveMdCommitWasCheap(analysis: LiveMdRuntimeState) {
  let trace = analysis.semanticTrace ?? analysis.trace;
  return trace.recordsAnalyzed <= 8 && trace.fallbackCount == 0;
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

function semanticAnalysisEpochsMatchState(pending: LiveMdPendingAnalysis, state: EditorState) {
  let current = runtimeEpochs(state);
  return (
    pending.epochs.markdownParserService == current.markdownParserService &&
    sameArrayItems(pending.epochs.markdownFeatures, current.markdownFeatures)
  );
}

function semanticAnalysisInputsStable(startState: EditorState, state: EditorState) {
  return (
    !markdownParserServiceChanged(startState, state) && !markdownFeaturesChanged(startState, state)
  );
}

function renderKeyContextForState(state: EditorState): LiveMdRenderKeyContext {
  let codeFenceLanguages = state.field(codeFenceLanguagesField, false) ?? null;
  let resolver = state.facet(liveMdImageSourceResolver);
  let reference = state.facet(liveMdLinkBaseUrl);
  let markdownFeatures = state.facet(liveMdMarkdownFeatureFacet);
  return {
    featuresEpoch: liveMdCompositeEpoch(
      ...markdownFeatures.flatMap((feature) =>
        feature.analyze
          ? [
              feature,
              feature.name,
              feature.priority ?? null,
              feature.query ?? null,
              feature.includeNested ?? false,
              feature.analyze,
            ]
          : [],
      ),
    ),
    referenceEpoch: liveMdValueEpoch(reference),
    rendererVersion: liveMdRendererVersion,
    resolverEpoch: liveMdCompositeEpoch(
      resolver,
      codeFenceLanguages == emptyCodeFenceLanguages ? null : codeFenceLanguages,
    ),
    themeEpoch: liveMdCompositeEpoch(...codeFenceHighlighters(state)),
  };
}

function scheduleLiveMdWork(
  revision: number,
  run: (deadline?: IdleDeadline) => void,
  options: LiveMdScheduleWorkOptions = {},
): LiveMdScheduledWork {
  let allowDeadlineYield = options.allowDeadlineYield ?? true;
  let quietDelay = options.quietDelay ?? liveMdSchedulerQuietDelay;
  let cancelled = false;
  let frame: number | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idle: number | null = null;

  let scheduleQuietTask = () => {
    frame = null;
    if (cancelled) return;
    quietTimer = setTimeout(scheduleIdleTask, quietDelay);
  };

  let scheduleIdleTask = () => {
    quietTimer = null;
    if (cancelled) return;
    if (shouldYieldForPendingInput(options)) {
      scheduleQuietTask();
      return;
    }
    let requestIdle = globalThis.requestIdleCallback;
    if (typeof requestIdle == "function") {
      idle = requestIdle((deadline) => {
        idle = null;
        if (cancelled) return;
        if (
          shouldYieldForPendingInput(options) ||
          (allowDeadlineYield && idleDeadlineExhausted(deadline))
        ) {
          scheduleQuietTask();
          return;
        }
        run(deadline);
      });
    } else {
      timer = setTimeout(() => {
        timer = null;
        if (cancelled) return;
        if (shouldYieldForPendingInput(options)) {
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

function shouldYieldForPendingInput(options: LiveMdScheduleWorkOptions) {
  return isInputPending() && (options.shouldYieldForInput?.() ?? true);
}

function idleDeadlineExhausted(deadline: IdleDeadline | undefined) {
  return Boolean(deadline && !deadline.didTimeout && deadline.timeRemaining() <= 0);
}

function scheduledYieldCheck(
  deadline: IdleDeadline | undefined,
  allowDeadlineYield: boolean,
  shouldYieldForInput: () => boolean,
) {
  return () => {
    if (isInputPending() && shouldYieldForInput()) throw new LiveMdScheduledYield("input");
    if (allowDeadlineYield && idleDeadlineExhausted(deadline)) {
      throw new LiveMdScheduledYield("deadline");
    }
  };
}

function offsetDocRange(range: DocRange, offset: number): DocRange {
  return { from: range.from + offset, to: range.to + offset };
}

function buildLiveMdAnalysis(
  state: EditorState,
  activeLines = getActiveLines(state),
  options: BuildLiveMdAnalysisOptions = {},
): LiveMdRuntimeState {
  let codeFenceLanguages = state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages;
  let tree = options.tree ?? syntaxTree(state);
  let markdownParserService = state.facet(liveMdMarkdownParserServiceFacet);
  let renderCache = options.previous?.renderCache ?? createLiveMdRenderCache();
  let renderKeyContext = renderKeyContextForState(state);

  if (markdownParserService) {
    let semanticAnalysis = buildLiveMdSemanticAnalysis({
      activeSourceRanges: options.activeSourceRanges,
      previous: options.previous,
      service: markdownParserService,
      state,
      transaction: options.transaction,
      leafAnalysisResume: options.leafAnalysisResume,
      transitionBase: options.transitionBase,
      tree,
      yieldCheck: options.yieldCheck,
    });
    if (
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
        surfaceInvalidationRanges: [],
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
        renderCache,
        trace: semanticAnalysis.trace,
        yieldCheck: options.yieldCheck,
      },
    );
    let direct = compileRuntimeDirectLayoutProjection(compileInput, semanticAnalysis, {
      previous: options.previous,
      transaction: options.transaction,
      transitionBase: options.transitionBase,
    });
    let trace = semanticAnalysis.trace;
    let analysis: LiveMdRuntimeState = {
      activeLines,
      activeSourceRanges: semanticAnalysis.activeSourceRanges,
      direct: projectionSetsFromLayer(direct),
      pending: null,
      renderCache,
      renderKeyContext,
      revision: options.revision ?? options.previous?.revision ?? 0,
      semantic: semanticAnalysis.semantic,
      semanticTrace: trace,
      surfaceInvalidationRanges: [],
      sourceIslandLeaves: semanticAnalysis.sourceIslandLeaves,
      trace,
      tree,
    };
    return analysis;
  }

  return {
    activeLines,
    activeSourceRanges: [],
    direct: emptyProjectionSets(),
    pending: null,
    renderCache,
    renderKeyContext,
    revision: options.revision ?? options.previous?.revision ?? 0,
    semantic: null,
    semanticTrace: null,
    surfaceInvalidationRanges: [],
    sourceIslandLeaves: sourceIslandIndexFromLeaves([]),
    trace: emptyLiveMdLeafAnalysisTrace(),
    tree,
  };
}

function projectionCompileInput(
  state: EditorState,
  activeLines: Set<number> | ReadonlySet<number>,
  activeSourceRanges: readonly DocRange[],
  options: {
    codeFenceLanguages?: CodeFenceLanguageMap;
    renderCache?: LiveMdRenderCache;
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
    renderKeyContext: renderKeyContextForState(state),
    renderCache: options.renderCache ?? createLiveMdRenderCache(),
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
      previous: options.previous.direct,
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
  if (rangesEqual(previousActiveRanges, input.currentActiveSourceRanges)) {
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
    renderCache: analysis.renderCache,
    sourceIslandMode: true,
    trace,
  });
  return compileVisibleSurfaceProjection(input, semantic.cache, ranges, {
    codeFenceHighlights: true,
  });
}

function emptySurfaceProjection(): SurfaceProjection {
  return projectionLayerFromSets(emptyProjectionSets());
}

function buildLiveMdSemanticAnalysis(input: {
  activeSourceRanges?: readonly DocRange[] | null;
  leafAnalysisResume?: LeafAnalysisResumeState | null;
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
  let renderKeyContext = renderKeyContextForState(input.state);
  if (previous && previousSemantic && canReuseSemanticState(input)) {
    let sourceIslandLeaves = previous.sourceIslandLeaves;
    let trace = emptyLeafAnalysisCacheTrace();
    let contextChanged = !sameLiveMdRenderKeyContext(previous.renderKeyContext, renderKeyContext);
    let semantic = contextChanged
      ? {
          cache: rekeyLeafAnalysisCache(previousSemantic.cache, renderKeyContext, trace),
          revision: previousSemantic.revision + 1,
        }
      : previousSemantic;
    return {
      activeSourceRanges:
        input.activeSourceRanges ?? activeMarkdownSourceRanges(input.state, sourceIslandLeaves),
      semantic,
      sourceIslandLeaves,
      trace,
      transition: null,
    };
  }

  let transaction = input.transaction;
  let transitionBase = input.transitionBase;
  if (
    previousSemantic &&
    transitionBase &&
    semanticAnalysisEpochsMatchState(transitionBase, input.state)
  ) {
    let transition = transitionLeafAnalysisCacheLocal({
      analysisInput: {
        renderKeyContext,
        service: input.service,
        state: input.state,
        tree: input.tree,
      },
      changes: transitionBase.changes,
      oldCache: previousSemantic.cache,
      oldDoc: transitionBase.baseDoc,
      oldSourceIslandLeaves: transitionBase.baseAnalysis.sourceIslandLeaves,
      resume: input.leafAnalysisResume,
      revision: transitionBase.revision,
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
        renderKeyContext,
        service: input.service,
        state: input.state,
        tree: input.tree,
      },
      changes: transitionBase.changes,
      oldCache: previousSemantic.cache,
      oldDoc: transitionBase.baseDoc,
      resume: input.leafAnalysisResume,
      revision: transitionBase.revision,
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
            renderKeyContext,
            service: input.service,
            state: input.state,
            tree: input.tree,
          },
          changes: transaction.changes,
          oldCache: previousSemantic.cache,
          oldDoc: transaction.startState.doc,
          resume: input.leafAnalysisResume,
          revision: semanticResumeRevision(input),
          snapshot: walked.snapshot,
          yieldCheck: input.yieldCheck,
        })
      : buildFreshLeafAnalysisCache({
          analysisInput: {
            renderKeyContext,
            service: input.service,
            state: input.state,
            tree: input.tree,
          },
          resume: input.leafAnalysisResume,
          revision: semanticResumeRevision(input),
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

function semanticResumeRevision(input: {
  previous?: LiveMdRuntimeState;
  transitionBase?: LiveMdPendingAnalysis;
}) {
  return (
    input.transitionBase?.revision ?? input.previous?.pending?.revision ?? input.previous?.revision
  );
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
    semanticAnalysisInputsStable(input.transaction.startState, input.state),
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
  let projection = compileRuntimeVisibleSurfaceProjection(state, runtime, ranges, trace);
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
  let surfaceSets = projectionSetsFromLayer(surface);
  let directDecorations = joinProjectionSetDecorations(runtime.direct);
  let surfaceDecorations = joinProjectionSetDecorations(surfaceSets);
  let sourceSafeDecorations = RangeSet.join([
    runtime.direct.sourceSafeDecorations,
    surface.sourceSafeDecorations,
  ]);
  let destructiveDecorations = RangeSet.join([
    runtime.direct.destructiveDecorations,
    surface.destructiveDecorations,
  ]);
  let snapshot: LiveMdAnalysis = {
    ...runtime,
    atomicRanges: RangeSet.join([runtime.direct.atomicRanges, surface.atomicRanges]),
    decorations: RangeSet.join([directDecorations, surfaceDecorations]),
    destructiveDecorations,
    directAtomicRanges: runtime.direct.atomicRanges,
    directDecorations,
    directDestructiveDecorations: runtime.direct.destructiveDecorations,
    directSourceSafeDecorations: runtime.direct.sourceSafeDecorations,
    interactiveDecorations: surface.interactiveDecorations,
    sourceSafeDecorations,
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
  inlineParserSessionDisposals: true,
  inlineParserSessions: true,
  languageApplyMs: true,
  languageWorkIterations: true,
  leavesCollected: true,
  directProjectionRecords: true,
  editSurfaceLines: true,
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
    editSurfaceRanges: mergeDocRanges([
      ...primary.editSurfaceRanges,
      ...secondary.editSurfaceRanges,
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

export function __testBuildCanonicalLiveMdAnalysis(
  state: EditorState,
  renderCache?: LiveMdRenderCache,
) {
  return buildCanonicalLiveMdAnalysis(state, renderCache);
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

export function __testRefreshLiveMdSurfacePreservingState(view: EditorView) {
  view.plugin(liveMdSurfacePlugin)?.refreshPreservingStateForTest();
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

function buildCanonicalLiveMdAnalysis(
  state: EditorState,
  renderCache?: LiveMdRenderCache,
): LiveMdAnalysis {
  let activeLines = getActiveLines(state);
  let codeFenceLanguages = state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages;
  let tree = syntaxTree(state);
  let markdownParserService = state.facet(liveMdMarkdownParserServiceFacet);
  let renderKeyContext = renderKeyContextForState(state);
  let canonicalRenderCache = renderCache ?? createLiveMdRenderCache();
  let cache =
    markdownParserService &&
    (() => {
      let semanticAnalysis = analyzeMarkdownLeafSemantics({
        renderKeyContext,
        service: markdownParserService,
        state,
        tree,
      });
      return {
        analysis: semanticAnalysis,
        cache: createLeafAnalysisCache(
          semanticAnalysis.records,
          semanticAnalysis.records.length + 1,
        ),
      };
    })();
  let trace = cache?.analysis.trace ?? emptyLiveMdLeafAnalysisTrace();
  let projection = cache
    ? compileProjectionLayersFromCache(
        projectionCompileInput(state, activeLines, cache.analysis.activeSourceRanges, {
          codeFenceLanguages,
          renderCache: canonicalRenderCache,
          sourceIslandMode: true,
          trace,
        }),
        cache.cache,
      )
    : {
        atomicRanges: RangeSet.empty,
        decorations: Decoration.none,
        destructiveDecorations: Decoration.none,
        direct: projectionLayerFromSets(emptyProjectionSets()),
        interactiveDecorations: Decoration.none,
        sourceSafeDecorations: Decoration.none,
        surface: projectionLayerFromSets(emptyProjectionSets()),
      };
  return {
    activeLines,
    activeSourceRanges: cache?.analysis.activeSourceRanges ?? [],
    atomicRanges: projection.atomicRanges,
    decorations: projection.decorations,
    direct: projectionSetsFromLayer(projection.direct),
    destructiveDecorations: projection.destructiveDecorations,
    directAtomicRanges: projection.direct.atomicRanges,
    directDecorations: projection.direct.decorations,
    directDestructiveDecorations: projection.direct.destructiveDecorations,
    directSourceSafeDecorations: projection.direct.sourceSafeDecorations,
    interactiveDecorations: projection.interactiveDecorations,
    pending: null,
    renderCache: canonicalRenderCache,
    renderKeyContext,
    revision: 0,
    semantic: cache ? { cache: cache.cache, revision: 0 } : null,
    semanticTrace: cache ? trace : null,
    sourceSafeDecorations: projection.sourceSafeDecorations,
    surfaceInvalidationRanges: [],
    sourceIslandLeaves: cache?.analysis.sourceIslandLeaves ?? sourceIslandIndexFromLeaves([]),
    surfaceAtomicRanges: projection.surface.atomicRanges,
    surfaceDecorations: projection.surface.decorations,
    surfaceDestructiveDecorations: projection.surface.destructiveDecorations,
    surfaceInteractiveDecorations: projection.surface.interactiveDecorations,
    surfaceSourceSafeDecorations: projection.surface.sourceSafeDecorations,
    trace,
    tree,
  };
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
