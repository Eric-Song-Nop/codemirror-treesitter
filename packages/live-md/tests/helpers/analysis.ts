import {
  type ChangeDesc,
  Compartment,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type StateCommand,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { history, redo, undo } from "@codemirror-treesitter/commands";
import { EditorView, type DecorationSet } from "@codemirror/view";
import {
  ensureSyntaxTree,
  HighlightStyle,
  syntaxHighlighting,
  tags as t,
  Tree,
  type DocRange,
  type Highlighter,
} from "@codemirror-treesitter/language";
import { afterEach, beforeEach, expect } from "vite-plus/test";
import {
  __testBuildCanonicalLiveMdAnalysis,
  __testBuildLiveMdAnalysis,
  __testFlushLiveMdAnalysis,
  __testLiveMdAnalysis,
  __testRefreshLiveMdSurface,
  liveMdAnalysis,
} from "../../src/core/decorations.js";
import { emptyLiveMdLeafAnalysisTrace } from "../../src/core/analysis/types.js";
import { liveMdMarkdownFeatureFacet, liveMdMarkdownFeatures } from "../../src/core/features.js";
import {
  liveMdImageSource,
  liveMdImageSourceResolver,
  normalizeMarkdownImageSource,
} from "../../src/core/images.js";
import { walkMarkdownBlocks } from "../../src/core/analysis/markdown-block-cursor.js";
import {
  buildFreshLeafAnalysisCache,
  createLeafAnalysisCache,
  findLeafAnalysisRecordsTouchingRanges,
  leafAnalysisCacheNextId,
  leafAnalysisCacheRecordCount,
  materializeLeafAnalysisCacheRecords,
  transitionLeafAnalysisCache,
  transitionLeafAnalysisCacheLocal,
} from "../../src/core/analysis/markdown-leaf-cache.js";
import {
  analyzeMarkdownLeafSemantics,
  hashDocRange,
} from "../../src/core/analysis/markdown-leaf-analysis.js";
import {
  compileFullDirectLayoutProjection,
  compileFullSurfaceProjection,
  compileVisibleSurfaceProjection,
} from "../../src/core/projection/compilers.js";
import {
  activeMarkdownSourceRanges,
  sourceIslandLeavesFromLeafAnalysisRecords,
  transitionSourceIslandLeavesFromLeafAnalysisRecords,
  type LiveMdSourceIslandLeaf,
} from "../../src/core/analysis/markdown-source-islands.js";
import { type LeafAnalysisRecord } from "../../src/core/analysis/descriptors.js";
import { type LiveMdLeafAnalysisTrace } from "../../src/core/analysis/types.js";
import {
  codeFenceLanguagesField,
  codeFenceHighlighterFacet,
  deleteLiveMdTree,
  liveMdCodeFenceHighlighting,
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  liveMdMarkdownParserServiceFacet,
  setCodeFenceLanguages,
} from "../../src/core/languages.js";
import { liveMdLinkBaseUrl, liveMdLinkInteractions, liveMdLinkOpen } from "../../src/core/links.js";
import { loadMarkdownParserService } from "@codemirror-treesitter/language-data";

export {
  __testBuildCanonicalLiveMdAnalysis,
  __testBuildLiveMdAnalysis,
  __testFlushLiveMdAnalysis,
  __testLiveMdAnalysis,
  __testRefreshLiveMdSurface,
  activeMarkdownSourceRanges,
  analyzeMarkdownLeafSemantics,
  buildFreshLeafAnalysisCache,
  codeFenceHighlighterFacet,
  codeFenceLanguagesField,
  Compartment,
  compileFullDirectLayoutProjection,
  compileFullSurfaceProjection,
  compileVisibleSurfaceProjection,
  createLeafAnalysisCache,
  deleteLiveMdTree,
  EditorState,
  EditorView,
  emptyLiveMdLeafAnalysisTrace,
  ensureSyntaxTree,
  findLeafAnalysisRecordsTouchingRanges,
  hashDocRange,
  HighlightStyle,
  history,
  leafAnalysisCacheNextId,
  leafAnalysisCacheRecordCount,
  liveMdAnalysis,
  liveMdCodeFenceHighlighting,
  liveMdImageSource,
  liveMdImageSourceResolver,
  liveMdLinkBaseUrl,
  liveMdLinkInteractions,
  liveMdLinkOpen,
  liveMdMarkdownFeatureFacet,
  liveMdMarkdownFeatures,
  liveMdMarkdownParserServiceFacet,
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  loadMarkdownParserService,
  materializeLeafAnalysisCacheRecords,
  normalizeMarkdownImageSource,
  RangeSet,
  redo,
  setCodeFenceLanguages,
  sourceIslandLeavesFromLeafAnalysisRecords,
  StateEffect,
  StateField,
  syntaxHighlighting,
  t,
  transitionLeafAnalysisCache,
  transitionLeafAnalysisCacheLocal,
  transitionSourceIslandLeavesFromLeafAnalysisRecords,
  Tree,
  undo,
  walkMarkdownBlocks,
};

export type {
  ChangeDesc,
  DecorationSet,
  DocRange,
  Extension,
  Highlighter,
  LeafAnalysisRecord,
  LiveMdLeafAnalysisTrace,
  LiveMdSourceIslandLeaf,
  StateCommand,
  Transaction,
  TransactionSpec,
};

export const testLightCodeFenceHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#0969da" },
]);

export const testDarkCodeFenceHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#f5a97f" },
]);

export function installAnalysisTestEnvironment() {
  let locationDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    if (locationDescriptor) {
      Object.defineProperty(globalThis, "location", locationDescriptor);
    }
  });
}

export async function markdownAnalysisState(
  doc: string,
  selectionText = "",
  extensions: Extension = [],
) {
  let selection = selectionText ? doc.indexOf(selectionText) : 0;
  let state = EditorState.create({
    doc,
    extensions: [
      await loadMarkdownExtension(),
      codeFenceLanguagesField,
      extensions,
      liveMdAnalysis,
    ],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state.update({ selection: { anchor: selection } }).state;
}

export async function markdownAnalysisView(
  doc: string,
  selectionText = "",
  extensions: Extension = [],
) {
  let selection = selectionText ? doc.indexOf(selectionText) : 0;
  let view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc,
      selection: { anchor: selection },
      extensions: [
        await loadMarkdownExtension(),
        codeFenceLanguagesField,
        extensions,
        liveMdAnalysis,
      ],
    }),
  });
  ensureSyntaxTree(view.state, doc.length, 5_000);
  view.dispatch({});
  return view;
}

export type TestLiveMdAnalysis = ReturnType<typeof __testLiveMdAnalysis>;
export type TestLeafAnalysisCache = NonNullable<TestLiveMdAnalysis["semantic"]>["cache"];
export type ScheduledLocalOracleMode = "full" | "semantic" | false;

export async function dispatchScheduledLocalEdit(
  view: EditorView,
  spec: TransactionSpec,
  label: string,
  options: { oracle?: ScheduledLocalOracleMode } = {},
) {
  let before = __testLiveMdAnalysis(view);
  if (!before.semantic) throw new Error(`${label}: expected semantic cache before edit`);
  let transaction = view.state.update(spec);

  view.dispatch(transaction);
  let pending = __testLiveMdAnalysis(view);
  expect(pending.pending, `${label}: source-first pending state`).toBeTruthy();

  await __testFlushLiveMdAnalysis(view);

  let after = __testLiveMdAnalysis(view);
  expect(after.pending, `${label}: scheduled analysis committed`).toBeNull();
  if (options.oracle !== false) {
    expectLocalFullFreshSemanticEquivalence(
      after,
      before.semantic.cache,
      transaction,
      view.state,
      label,
      options.oracle ?? "full",
    );
  }
  return { after, before, pending, transaction };
}

export function expectLocalFullFreshSemanticEquivalence(
  local: TestLiveMdAnalysis,
  oldCache: TestLeafAnalysisCache,
  transaction: Transaction,
  state: EditorState,
  label: string,
  mode: Exclude<ScheduledLocalOracleMode, false>,
) {
  if (!local.semantic) throw new Error(`${label}: expected local semantic cache after edit`);
  let { freshCache, fullCache } = semanticTransitionOracles(
    transaction.startState,
    state,
    transaction.changes,
    oldCache,
  );

  let localTransitionCache = canonicalSemanticTransitionCache(state, local.semantic.cache);
  let fullTransitionCache = canonicalSemanticTransitionCache(state, fullCache);
  expect(
    firstCanonicalMismatch(localTransitionCache, fullTransitionCache),
    `${label}: local transition must match full-walk transition with cache ids`,
  ).toBeNull();
  expect(
    canonicalSemanticRecordsFromCache(state, local.semantic.cache),
    `${label}: local transition must match fresh rebuild semantics`,
  ).toEqual(canonicalSemanticRecordsFromCache(state, freshCache));
  let fullSourceIslandLeaves = sourceIslandLeavesFromLeafAnalysisRecords(
    state.doc,
    materializeLeafAnalysisCacheRecords(fullCache),
  );
  expect(
    canonicalSourceIslandLeaves(local.sourceIslandLeaves),
    `${label}: local source islands vs full-walk transition`,
  ).toEqual(canonicalSourceIslandLeaves(fullSourceIslandLeaves));
  expect(local.activeSourceRanges, `${label}: local active lookup vs full-walk transition`).toEqual(
    activeMarkdownSourceRanges(state, fullSourceIslandLeaves),
  );
  if (mode == "semantic") return;

  let freshAnalysis = __testBuildLiveMdAnalysis(state);
  expect(canonicalAnalysis(state, local), `${label}: local projection vs fresh`).toEqual(
    canonicalAnalysis(state, freshAnalysis),
  );
  expect(
    canonicalAnalysis(state, local),
    `${label}: local projection vs canonical full-query projection`,
  ).toEqual(canonicalAnalysis(state, __testBuildCanonicalLiveMdAnalysis(state)));
}

export function semanticTransitionOracles(
  startState: EditorState,
  state: EditorState,
  changes: ChangeDesc,
  oldCache: TestLeafAnalysisCache,
) {
  let service = markdownParserService(state);
  let tree = service.blockParser.parse(state.doc);
  try {
    let walked = walkMarkdownBlocks(tree, state.doc);
    let analysisInput = { service, state, tree };
    let fullTransition = transitionLeafAnalysisCache({
      analysisInput,
      changes,
      oldCache,
      oldDoc: startState.doc,
      snapshot: walked.snapshot,
    });
    let freshTransition = buildFreshLeafAnalysisCache({
      analysisInput,
      snapshot: walked.snapshot,
    });
    return {
      freshCache: freshTransition.cache,
      fullCache: fullTransition.cache,
    };
  } finally {
    deleteLiveMdTree(tree);
  }
}

export function markdownParserService(state: EditorState) {
  let service = state.facet(liveMdMarkdownParserServiceFacet);
  if (!service) throw new Error("Expected LiveMD Markdown parser service");
  return service;
}

export async function createLocalCacheHarness(doc: string, extensions: Extension = []) {
  let service = await loadMarkdownParserService();
  let state = EditorState.create({ doc, extensions });
  let tree = service.blockParser.parse(state.doc);
  let snapshot = walkMarkdownBlocks(tree, state.doc).snapshot;
  let current = buildFreshLeafAnalysisCache({
    analysisInput: { service, state, tree },
    snapshot,
  });
  let sourceIslandLeaves: readonly LiveMdSourceIslandLeaf[] =
    sourceIslandLeavesFromLeafAnalysisRecords(
      state.doc,
      materializeLeafAnalysisCacheRecords(current.cache),
    );

  let harness = {
    current,
    service,
    sourceIslandLeaves,
    state,
    tree,
    apply(transaction: Transaction) {
      let previousTree = harness.tree;
      let editedTree = service.blockParser.editWrappedTree(
        previousTree,
        transaction.changes,
        harness.state.doc,
        transaction.state.doc,
      );
      let nextTree = service.blockParser.parse(transaction.state.doc, editedTree);
      let local = transitionLeafAnalysisCacheLocal({
        analysisInput: { service, state: transaction.state, tree: nextTree },
        changes: transaction.changes,
        oldCache: harness.current.cache,
        oldDoc: harness.state.doc,
        oldSourceIslandLeaves: harness.sourceIslandLeaves,
      });
      if (local.fallback) throw new Error("Expected range-local cache transition");
      if (!local.sourceIslandLeaves) {
        throw new Error("Expected range-local source island transition");
      }

      harness.current = local;
      harness.state = transaction.state;
      harness.tree = nextTree;
      harness.sourceIslandLeaves = local.sourceIslandLeaves;
      deleteLiveMdTree(previousTree);
      deleteLiveMdTree(editedTree);
      return local;
    },
    destroy() {
      deleteLiveMdTree(harness.tree);
    },
  };
  return harness;
}

export function commandTransaction(state: EditorState, command: StateCommand, label: string) {
  let transaction: Transaction | null = null;
  let dispatched = command({
    state,
    dispatch: (next) => {
      transaction = next;
    },
  });
  expect(dispatched, label).toBe(true);
  if (!transaction) throw new Error(`${label}: command did not dispatch`);
  return transaction;
}

export function expectPr75LocalTrace(
  trace: LiveMdLeafAnalysisTrace | null | undefined,
  label: string,
  options: {
    cacheIndexCallbacksLessThan?: number;
    cacheIndexQueriesLessThan?: number;
    recordsAnalyzed?: number;
    recordsCollectedLessThan?: number;
    recordsMappedLessThan?: number;
    recordsReusedGreaterThan?: number;
    recordsVisitedLessThan?: number;
  } = {},
) {
  if (!trace) throw new Error(`${label}: expected semantic trace`);
  expect(trace.recordsAnalyzed, label).toBe(options.recordsAnalyzed ?? 1);
  expect(trace.fallbackCount, label).toBe(0);
  expect(trace.recordsVisited, label).toBeLessThan(options.recordsVisitedLessThan ?? 8);
  expect(trace.recordsCollected, label).toBeLessThan(options.recordsCollectedLessThan ?? 10);
  expect(trace.recordsMappedIndividually, label).toBeLessThan(options.recordsMappedLessThan ?? 10);
  expect(trace.cacheFullMaterializations, label).toBe(0);
  expect(trace.cacheIndexCallbacks, label).toBeLessThan(options.cacheIndexCallbacksLessThan ?? 10);
  expect(trace.cacheIndexQueries, label).toBeLessThan(options.cacheIndexQueriesLessThan ?? 10);
  if (options.recordsReusedGreaterThan != null) {
    expect(trace.recordsReused, label).toBeGreaterThan(options.recordsReusedGreaterThan);
  }
}

export function projectionCompileInputForTest(
  state: EditorState,
  analysis: ReturnType<typeof __testBuildLiveMdAnalysis>,
  options: {
    codeFenceHighlighters?: readonly Highlighter[];
    trace?: ReturnType<typeof emptyLiveMdLeafAnalysisTrace>;
  } = {},
) {
  return {
    activeLines: new Set(analysis.activeLines),
    activeSourceRanges: analysis.activeSourceRanges,
    codeFenceHighlighters:
      options.codeFenceHighlighters ?? state.facet(codeFenceHighlighterFacet) ?? [],
    codeFenceLanguages: state.field(codeFenceLanguagesField, false) ?? new Map(),
    imageSourceResolver: state.facet(liveMdImageSourceResolver),
    linkBaseUrl: state.facet(liveMdLinkBaseUrl),
    markdownFeatures: state.facet(liveMdMarkdownFeatureFacet),
    sourceIslandMode: true,
    state,
    trace: options.trace ?? emptyLiveMdLeafAnalysisTrace(),
  };
}

export function expectDirectProjectionMatchesFullOracle(
  state: EditorState,
  analysis: ReturnType<typeof __testLiveMdAnalysis>,
) {
  if (!analysis.semantic) throw new Error("Expected semantic cache for direct projection oracle");
  let direct = compileFullDirectLayoutProjection(
    projectionCompileInputForTest(state, analysis),
    analysis.semantic.cache,
  );
  expect(
    canonicalProjectionFromSets(state, analysis.directDecorations, analysis.directAtomicRanges),
  ).toEqual(canonicalProjectionFromSets(state, direct.decorations, direct.atomicRanges));
  expect(canonicalDecorationsFromSet(state, analysis.directSourceSafeDecorations)).toEqual(
    canonicalDecorationsFromSet(state, direct.sourceSafeDecorations),
  );
  expect(canonicalDecorationsFromSet(state, analysis.directDestructiveDecorations)).toEqual(
    canonicalDecorationsFromSet(state, direct.destructiveDecorations),
  );
}

export function explicitCodeFenceSurface(
  state: EditorState,
  highlighters: readonly Highlighter[],
  trace = emptyLiveMdLeafAnalysisTrace(),
  analysis = __testBuildLiveMdAnalysis(state),
) {
  if (!analysis.semantic) throw new Error("Expected semantic cache for code fence oracle");
  return compileVisibleSurfaceProjection(
    projectionCompileInputForTest(state, analysis, {
      codeFenceHighlighters: highlighters,
      trace,
    }),
    analysis.semantic.cache,
    state.doc.length ? [{ from: 0, to: state.doc.length }] : [],
    { codeFenceHighlights: true },
  );
}

export function explicitCodeFenceClasses(state: EditorState, highlighters: readonly Highlighter[]) {
  return decorationClassesFromSet(state, explicitCodeFenceSurface(state, highlighters).decorations);
}

export function imagePreviewSources(state: EditorState) {
  return imagePreviewSourcesFromSet(state, __testBuildLiveMdAnalysis(state).decorations);
}

export function imagePreviewSourcesFromSet(state: EditorState, decorations: DecorationSet) {
  let sources: string[] = [];
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    let widget = (value.spec as { widget?: unknown }).widget;
    if (widget && widget.constructor.name == "ImagePreviewWidget") {
      sources.push((widget as { src: string }).src);
    }
  });
  return sources;
}

export type TestMarkdownTable = {
  alignments: string[];
  header: string[];
  rows: string[][];
};

export function tablePreviewTables(
  state: EditorState,
  analysis = __testBuildLiveMdAnalysis(state),
): TestMarkdownTable[] {
  let tables: TestMarkdownTable[] = [];
  analysis.decorations.between(0, state.doc.length, (_from, _to, value) => {
    let widget = (value.spec as { widget?: unknown }).widget;
    if (widget && widget.constructor.name == "TablePreviewWidget") {
      tables.push((widget as { table: TestMarkdownTable }).table);
    }
  });
  return tables;
}

export function trackNativeTreeDeletes(tree: Tree, onDelete: () => void): number {
  let count = 0;
  if (tree.tree) {
    count++;
    let wrappedTree = tree.tree;
    let deleteTree = wrappedTree.delete.bind(wrappedTree);
    wrappedTree.delete = () => {
      onDelete();
      deleteTree();
    };
  }
  for (let nested of tree.nested) {
    count += trackNativeTreeDeletes(nested.tree, onDelete);
  }
  return count;
}

export function recordBySource(
  state: EditorState,
  analysis: ReturnType<typeof __testLiveMdAnalysis>,
  source: string,
) {
  let record = analysis.semantic
    ? materializeLeafAnalysisCacheRecords(analysis.semantic.cache).find(
        (candidate) =>
          state.sliceDoc(candidate.sourceRange.from, candidate.sourceRange.to) == source,
      )
    : undefined;
  if (!record) throw new Error(`Missing semantic record for source: ${source}`);
  return record;
}

export function markerRecordBySource(
  state: EditorState,
  analysis: ReturnType<typeof __testLiveMdAnalysis>,
  source: string,
  markerKind: "listMarker" | "taskMarker",
) {
  let record = analysis.semantic
    ? materializeLeafAnalysisCacheRecords(analysis.semantic.cache).find(
        (candidate) =>
          candidate.kind == "marker" &&
          state.sliceDoc(candidate.sourceRange.from, candidate.sourceRange.to) == source &&
          candidate.analysis.structuralEffects.some((descriptor) => descriptor.kind == markerKind),
      )
    : undefined;
  if (!record) throw new Error(`Missing ${markerKind} semantic record for source: ${source}`);
  return record;
}

export function taskMarkerChecked(record: ReturnType<typeof recordBySource>) {
  let taskMarker = record.analysis.structuralEffects.find(
    (descriptor) => descriptor.kind == "taskMarker",
  );
  if (!taskMarker || taskMarker.kind != "taskMarker") {
    throw new Error("Missing task marker descriptor");
  }
  return taskMarker.checked;
}

export function expectRelativeLineClassRange(
  record: ReturnType<typeof recordBySource>,
  className: string,
  range: DocRange,
) {
  let lineClass = record.analysis.structuralEffects.find(
    (descriptor) => descriptor.kind == "lineClass" && descriptor.className == className,
  );
  if (!lineClass || lineClass.kind != "lineClass") {
    throw new Error(`Missing ${className} line class descriptor`);
  }
  expect(lineClass.range).toEqual(range);
}

export function legacyFeatureFullQueryCount(analysis: ReturnType<typeof __testLiveMdAnalysis>) {
  return analysis.semanticTrace?.legacyFeatureFullQueryCount;
}

export function decorationClasses(
  state: EditorState,
  analysis = __testLiveMdAnalysis({ state } as EditorView),
) {
  return decorationClassesFromSet(state, analysis.decorations);
}

export function decorationClassesFromSet(state: EditorState, decorations: DecorationSet) {
  let classes = new Set<string>();
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    let className = (value.spec as { class?: string }).class;
    for (let name of className?.split(/\s+/) ?? []) {
      if (name) classes.add(name);
    }
  });
  return classes;
}

export function linkHrefsFromSet(state: EditorState, decorations: DecorationSet) {
  let hrefs: string[] = [];
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    let href = (value.spec as { attributes?: { "data-live-md-href"?: string } }).attributes?.[
      "data-live-md-href"
    ];
    if (href) hrefs.push(href);
  });
  return hrefs.sort();
}

export function widgetNamesFromSet(state: EditorState, decorations: DecorationSet) {
  let names: string[] = [];
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    let widget = (value.spec as { widget?: unknown }).widget;
    if (widget && typeof widget == "object") names.push(widget.constructor.name);
  });
  return names;
}

export function widgetInstancesFromSet(
  state: EditorState,
  decorations: DecorationSet,
  name: string,
) {
  let widgets: unknown[] = [];
  decorations.between(0, state.doc.length, (_from, _to, value) => {
    let widget = (value.spec as { widget?: unknown }).widget;
    if (widget && typeof widget == "object" && widget.constructor.name == name) {
      widgets.push(widget);
    }
  });
  return widgets;
}

export function requiredElement(view: EditorView, selector: string) {
  let element = view.dom.querySelector(selector);
  if (!element) throw new Error(`Missing element for selector ${selector}`);
  return element;
}

export function expectNoElement(view: EditorView, selector: string) {
  expect(view.dom.querySelector(selector)).toBeNull();
}

export function expectSelectionHead(view: EditorView, position: number, label: string) {
  expect(view.state.selection.main.head, label).toBe(position);
}

export function lineRangeBySource(state: EditorState, lineText: string): DocRange {
  let line = lineBySource(state, lineText);
  return { from: line.from, to: line.to };
}

export function expectDirectPatchLocal(
  trace: LiveMdLeafAnalysisTrace | null | undefined,
  state: EditorState,
  allowedRanges: readonly DocRange[],
) {
  expect(trace?.directProjectionWindows).toBeTruthy();
  let windows = trace?.directProjectionWindows ?? [];
  expect(windows).not.toEqual([{ from: 0, to: state.doc.length }]);
  for (let window of windows) {
    expect(allowedRanges.some((range) => containsDocRange(range, window))).toBe(true);
  }
  let coveredWidth = windows.reduce((sum, window) => sum + (window.to - window.from), 0);
  expect(coveredWidth).toBeLessThan(state.doc.length);
}

export function lineBySource(state: EditorState, lineText: string) {
  let from = state.sliceDoc().indexOf(lineText);
  if (from < 0) throw new Error(`Missing test line text: ${lineText}`);
  return state.doc.lineAt(from);
}

export function lineHasClass(
  state: EditorState,
  lineText: string,
  className: string,
  analysis = __testLiveMdAnalysis({ state } as EditorView),
) {
  let from = state.sliceDoc().indexOf(lineText);
  if (from < 0) throw new Error(`Missing test line text: ${lineText}`);
  let line = state.doc.lineAt(from);
  return lineClasses(state, analysis).get(line.from)?.has(className) ?? false;
}

export function lineClasses(
  state: EditorState,
  analysis = __testLiveMdAnalysis({ state } as EditorView),
) {
  let classes = new Map<number, Set<string>>();
  analysis.decorations.between(0, state.doc.length, (from, to, value) => {
    if (from != to) return;
    let className = (value.spec as { class?: string }).class;
    if (!className) return;
    let lineFrom = state.doc.lineAt(from).from;
    let lineClasses = classes.get(lineFrom);
    if (!lineClasses) classes.set(lineFrom, (lineClasses = new Set()));
    for (let name of className.split(/\s+/)) {
      if (name) lineClasses.add(name);
    }
  });
  return classes;
}

export function markHeadingFeature(className: string) {
  return liveMdMarkdownFeatures([
    {
      name: className,
      query: "(atx_heading) @heading",
      decorate({ addMark, node }) {
        let heading = node("heading");
        if (!heading) return;
        addMark(heading.from, heading.to, className);
      },
    },
  ]);
}

export function numberedParagraphDoc(count: number) {
  return Array.from({ length: count }, (_value, index) => `paragraph ${index} **bold**`).join(
    "\n\n",
  );
}

export function numberedPlainParagraphDoc(count: number) {
  return Array.from({ length: count }, (_value, index) => `paragraph ${index}`).join("\n\n");
}

export function onlyRecordTouching(cache: TestLeafAnalysisCache, range: DocRange, label: string) {
  let records = findLeafAnalysisRecordsTouchingRanges(cache, [range]);
  let exact = records.filter(
    (record) => record.sourceRange.from == range.from && record.sourceRange.to == range.to,
  );
  expect(exact, label).toHaveLength(1);
  return exact[0]!;
}

export function mapRangeForTest(range: DocRange, changes: ChangeDesc): DocRange {
  let from = changes.mapPos(range.from, 1);
  let to = changes.mapPos(range.to, -1);
  return from <= to ? { from, to } : { from: to, to: from };
}

export function numberedListDoc(count: number) {
  return Array.from({ length: count }, (_value, index) => `- item ${index} body **bold**`).join(
    "\n",
  );
}

export function numberedQuoteParagraphDoc(count: number) {
  return Array.from({ length: count }, (_value, index) => `> quote ${index} body **bold**`).join(
    "\n>\n",
  );
}

export function randomEditSeedDoc() {
  return (
    "# Random Seed\n\n" +
    "alpha **one** and [link](https://example.com)\n\n" +
    "- [ ] todo item\n" +
    "- item two\n\n" +
    "> quote **bold**\n>\n> next quote\n\n" +
    "| Name | Value |\n" +
    "| --- | --- |\n" +
    "| alpha | 1 |\n\n" +
    "```ts\n" +
    "let answer = 1;\n" +
    "```\n\n" +
    "tail\n"
  );
}

export function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

export function randomTextEdit(doc: string, random: () => number): TransactionSpec["changes"] {
  let operation = Math.floor(random() * 3);
  let insertions = ["!", " more", "\nnew line", " 中", " `code`", " **x**"];
  if (operation == 0 || doc.length == 0) {
    let from = randomPosition(doc, random);
    return { from, insert: insertions[Math.floor(random() * insertions.length)]! };
  }

  let from = Math.floor(random() * doc.length);
  let maxDelete = Math.min(8, doc.length - from);
  let to = from + 1 + Math.floor(random() * maxDelete);
  if (operation == 1) return { from, to };
  return {
    from,
    insert: insertions[Math.floor(random() * insertions.length)]!,
    to,
  };
}

export function randomPosition(doc: string, random: () => number) {
  return Math.floor(random() * (doc.length + 1));
}

export function liveMdKitchenSinkDoc() {
  return (
    "# Heading One\n\n" +
    "Paragraph with _emphasis_, **bold**, ~~strike~~, `code`, [link](https://example.com), <https://example.com>, $x^2$.\n\n" +
    "> Quote line with **bold** and $y$.\n" +
    "> second quote line\n\n" +
    "- item one\n" +
    "- [x] done item\n" +
    "- [ ] todo item\n\n" +
    "![Alt image](https://example.com/image.png)\n\n" +
    "$$\n" +
    "E = mc^2\n" +
    "$$\n\n" +
    "| Name | Value |\n" +
    "| --- | ---: |\n" +
    "| alpha | 1 |\n" +
    "| beta | 2 |\n\n" +
    "```ts\n" +
    "type Note = { title: string; done: boolean };\n" +
    "const answer = 42;\n" +
    "console.log(answer);\n" +
    "```\n\n" +
    "After anchor line\n"
  );
}

export function canonicalAnalysis(state: EditorState, analysis = __testBuildLiveMdAnalysis(state)) {
  return canonicalProjectionFromSets(state, analysis.decorations, analysis.atomicRanges);
}

export function canonicalProjectionFromSets(
  state: EditorState,
  decorationsSet: DecorationSet,
  atomicRangesSet: ReturnType<typeof __testBuildLiveMdAnalysis>["atomicRanges"],
) {
  let decorations: Array<{ from: number; spec: unknown; to: number }> = [];
  decorationsSet.between(0, state.doc.length, (from, to, value) => {
    decorations.push({ from, spec: canonicalDecorationSpec(value.spec), to });
  });
  decorations.sort(compareCanonicalRange);
  decorations = mergeCanonicalLineClassDecorations(decorations);

  let atomicRanges: Array<{ from: number; to: number; value: string }> = [];
  atomicRangesSet.between(0, state.doc.length, (from, to, value) => {
    atomicRanges.push({ from, to, value: value.constructor.name });
  });
  atomicRanges.sort(compareCanonicalRange);

  return { atomicRanges, decorations };
}

export function canonicalDecorationsFromSet(state: EditorState, decorationsSet: DecorationSet) {
  return canonicalProjectionFromSets(state, decorationsSet, RangeSet.empty).decorations;
}

export function mergeCanonicalLineClassDecorations(
  decorations: Array<{ from: number; spec: unknown; to: number }>,
) {
  let merged: Array<{ from: number; spec: unknown; to: number }> = [];
  for (let decoration of decorations) {
    let previous = merged[merged.length - 1];
    let previousClass = canonicalLineClass(previous);
    let currentClass = canonicalLineClass(decoration);
    if (
      previous &&
      previous.from == decoration.from &&
      previous.to == decoration.to &&
      previousClass &&
      currentClass
    ) {
      previous.spec = {
        class: [...new Set([...previousClass.split(" "), ...currentClass.split(" ")])]
          .filter(Boolean)
          .sort()
          .join(" "),
      };
      continue;
    }
    merged.push(decoration);
  }
  return merged;
}

export function canonicalLineClass(
  decoration: { from: number; spec: unknown; to: number } | undefined,
) {
  if (!decoration || decoration.from != decoration.to) return null;
  let spec = decoration.spec as { class?: unknown };
  if (!spec || typeof spec.class != "string" || Object.keys(spec).length != 1) return null;
  return spec.class;
}

export function canonicalSemanticCache(
  state: EditorState,
  analysis: ReturnType<typeof __testLiveMdAnalysis>,
): CanonicalSemanticRecord[] {
  return analysis.semantic ? canonicalSemanticRecordsFromCache(state, analysis.semantic.cache) : [];
}

export function canonicalSemanticRecordsFromCache(
  state: EditorState,
  cache: TestLeafAnalysisCache,
): CanonicalSemanticRecord[] {
  let records = materializeLeafAnalysisCacheRecords(cache).map((record) =>
    canonicalSemanticRecord(state, record),
  );
  return records.sort(compareCanonicalSemanticRecord);
}

export function canonicalSemanticTransitionCache(
  state: EditorState,
  cache: TestLeafAnalysisCache,
): CanonicalSemanticTransitionRecord[] {
  let records = materializeLeafAnalysisCacheRecords(cache).map((record) => ({
    ...canonicalSemanticRecord(state, record),
    cacheId: record.cacheId,
  }));
  return records.sort(compareCanonicalSemanticTransitionRecord);
}

export function canonicalSourceIslandLeaves(leaves: readonly LiveMdSourceIslandLeaf[]) {
  return leaves
    .map((leaf) => ({
      contextKey: leaf.contextKey,
      kind: leaf.kind,
      sourceRange: leaf.sourceRange,
    }))
    .sort(
      (left, right) =>
        left.sourceRange.from - right.sourceRange.from ||
        left.sourceRange.to - right.sourceRange.to ||
        left.kind.localeCompare(right.kind) ||
        left.contextKey.localeCompare(right.contextKey),
    );
}

export function canonicalSemanticRecord(
  state: EditorState,
  record: LeafAnalysisRecord,
): CanonicalSemanticRecord {
  return {
    analysis: {
      analysisKey: record.analysis.analysisKey,
      descriptors: record.analysis.descriptors,
      renderKey: record.analysis.renderKey,
      structuralEffects: record.analysis.structuralEffects,
    },
    context: canonicalMarkdownBlockContext(record.context),
    contextKey: record.contextKey,
    effectRange: record.effectRange,
    kind: record.kind,
    range: record.range,
    source: state.sliceDoc(record.sourceRange.from, record.sourceRange.to),
    sourceHash: record.sourceHash.toString(16),
    sourceRange: record.sourceRange,
  };
}

export function canonicalMarkdownBlockContext(context: LeafAnalysisRecord["context"]) {
  return {
    listPath: context.listPath.map((item) => ({
      itemRange: item.itemRange,
      markerRange: item.markerRange,
      markerText: item.markerText,
      task: item.task
        ? {
            checked: item.task.checked,
            range: item.task.range,
          }
        : null,
    })),
    quoteDepth: context.quoteDepth,
    quoteMarkers: context.quoteMarkers.map((range) => ({ from: range.from, to: range.to })),
  };
}

export function compareCanonicalSemanticRecord(
  left: CanonicalSemanticRecord,
  right: CanonicalSemanticRecord,
) {
  return (
    left.range.from - right.range.from ||
    left.range.to - right.range.to ||
    left.sourceRange.from - right.sourceRange.from ||
    left.sourceRange.to - right.sourceRange.to ||
    left.effectRange.from - right.effectRange.from ||
    left.effectRange.to - right.effectRange.to ||
    left.kind.localeCompare(right.kind) ||
    left.contextKey.localeCompare(right.contextKey) ||
    left.source.localeCompare(right.source) ||
    JSON.stringify(left.analysis).localeCompare(JSON.stringify(right.analysis))
  );
}

export function compareCanonicalSemanticTransitionRecord(
  left: CanonicalSemanticTransitionRecord,
  right: CanonicalSemanticTransitionRecord,
) {
  return compareCanonicalSemanticRecord(left, right) || left.cacheId - right.cacheId;
}

export function firstCanonicalMismatch(
  left: readonly CanonicalSemanticTransitionRecord[],
  right: readonly CanonicalSemanticTransitionRecord[],
) {
  if (left.length != right.length) {
    return { leftLength: left.length, rightLength: right.length };
  }
  for (let index = 0; index < left.length; index++) {
    let leftRecord = left[index]!;
    let rightRecord = right[index]!;
    if (JSON.stringify(leftRecord) != JSON.stringify(rightRecord)) {
      return { index, left: leftRecord, right: rightRecord };
    }
  }
  return null;
}

export type CanonicalSemanticRecord = {
  analysis: {
    analysisKey: string;
    descriptors: unknown;
    renderKey: string;
    structuralEffects: unknown;
  };
  context: ReturnType<typeof canonicalMarkdownBlockContext>;
  contextKey: string;
  effectRange: DocRange;
  kind: string;
  range: DocRange;
  source: string;
  sourceHash: string;
  sourceRange: DocRange;
};

export type CanonicalSemanticTransitionRecord = CanonicalSemanticRecord & {
  cacheId: number;
};

export function compareCanonicalRange(
  left: { from: number; spec?: unknown; to: number; value?: string },
  right: { from: number; spec?: unknown; to: number; value?: string },
) {
  return (
    left.from - right.from ||
    left.to - right.to ||
    JSON.stringify(left.spec ?? left.value).localeCompare(JSON.stringify(right.spec ?? right.value))
  );
}

export function rangesOverlap(left: DocRange, right: DocRange) {
  return left.from < right.to && right.from < left.to;
}

export function containsDocRange(outer: DocRange, inner: DocRange) {
  return outer.from <= inner.from && inner.to <= outer.to;
}

export function clipCanonicalProjectionToRanges(
  projection: ReturnType<typeof canonicalProjectionFromSets>,
  ranges: readonly DocRange[],
): ReturnType<typeof canonicalProjectionFromSets> {
  let decorations = projection.decorations.flatMap((decoration) => {
    if (canonicalSpecHasWidget(decoration.spec)) {
      return ranges.some((range) => rangesOverlap(decoration, range)) ? [decoration] : [];
    }
    return intersectCanonicalRange(decoration, ranges).map((range) => ({
      ...decoration,
      ...range,
    }));
  });
  let atomicRanges = projection.atomicRanges.flatMap((atomicRange) =>
    intersectCanonicalRange(atomicRange, ranges).map((range) => ({
      ...atomicRange,
      ...range,
    })),
  );
  decorations.sort(compareCanonicalRange);
  atomicRanges.sort(compareCanonicalRange);
  return { atomicRanges, decorations };
}

export function canonicalSpecHasWidget(spec: unknown) {
  return Boolean(spec && typeof spec == "object" && "widget" in spec);
}

export function intersectCanonicalRange<T extends { from: number; to: number }>(
  target: T,
  ranges: readonly DocRange[],
) {
  let clipped: DocRange[] = [];
  for (let range of ranges) {
    let from = Math.max(target.from, range.from);
    let to = Math.min(target.to, range.to);
    if (from < to) clipped.push({ from, to });
  }
  return clipped;
}

export function canonicalDecorationSpec(spec: Record<string, unknown>) {
  let normalized = { ...spec };
  if (typeof normalized.class == "string") {
    normalized.class = normalized.class.split(/\s+/).filter(Boolean).sort().join(" ");
  }
  let widget = spec.widget;
  if (widget && typeof widget == "object") {
    return {
      ...normalized,
      widget: {
        name: widget.constructor.name,
        props: Object.fromEntries(
          Object.getOwnPropertyNames(widget)
            .sort()
            .map((name) => [name, (widget as Record<string, unknown>)[name]]),
        ),
      },
    };
  }
  return normalized;
}
