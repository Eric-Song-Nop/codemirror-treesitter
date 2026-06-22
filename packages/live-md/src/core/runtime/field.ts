import { EditorState, RangeSet, StateField, type Extension } from "@codemirror/state";
import {
  syntaxHighlighters,
  syntaxTree,
  type Highlighter,
  type Tree,
} from "@codemirror-treesitter/language";
import { EditorView } from "@codemirror/view";
import {
  activeMarkdownSourceRanges,
  analyzeLiveMdSourceIslands,
  type LiveMdSourceIslandAnalysis,
} from "../analysis/markdown-source-islands.js";
import { analyzeMarkdownLeafSemantics } from "../analysis/markdown-leaf-analysis.js";
import { isInsideSkippedRange, matchRoot, queryLiveMdMatches } from "../analysis/query.js";
import { collectTable } from "../analysis/tables.js";
import {
  emptyLiveMdLeafAnalysisTrace,
  type CapturedTable,
  type DocRange,
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
import { createLiveMdBuild, finishAtomicRanges, finishDecorations } from "../projection/emit.js";
import { applyLiveMdMarkdownFeatures, processLiveMdMatch } from "../projection/builtin.js";
import { projectLeafRecords } from "../projection/project-leaf.js";
import { type LiveMdAnalysis } from "./types.js";

const defaultCodeFenceHighlighters = [liveMdDefaultCodeFenceHighlighter] as const;

const liveMdAnalysisField = StateField.define<LiveMdAnalysis>({
  create(state) {
    return buildLiveMdAnalysis(state, getActiveLines(state));
  },
  update(value, transaction) {
    let tree = syntaxTree(transaction.state);
    let activeLines = getActiveLines(transaction.state);
    let activeSourceRanges =
      tree == value.tree && !transaction.docChanged
        ? activeMarkdownSourceRanges(transaction.state, value.sourceIslandLeaves)
        : null;
    let activeLinesStable = sameSetItems(activeLines, value.activeLines);
    let selectionProjectionStable =
      value.sourceIslandLeaves.length > 0
        ? activeSourceRanges != null &&
          sameRanges(activeSourceRanges, value.activeSourceRanges) &&
          (!transaction.state.facet(liveMdMarkdownFeatureFacet).length || activeLinesStable)
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

    return buildLiveMdAnalysis(transaction.state, activeLines);
  },
  provide(field) {
    return [
      EditorView.decorations.from(field, (analysis) => analysis.decorations),
      EditorView.atomicRanges.of(
        (view) => view.state.field(field, false)?.atomicRanges ?? RangeSet.empty,
      ),
    ];
  },
});

export const liveMdAnalysis: Extension = liveMdAnalysisField;

function buildLiveMdAnalysis(
  state: EditorState,
  activeLines = getActiveLines(state),
): LiveMdAnalysis {
  let codeFenceLanguages = state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages;
  let tree = syntaxTree(state);
  let markdownParserService = state.facet(liveMdMarkdownParserServiceFacet);

  if (markdownParserService) {
    let semanticAnalysis = analyzeMarkdownLeafSemantics({
      service: markdownParserService,
      state,
      tree,
    });
    let build = createLiveMdBuild({
      activeLines,
      activeSourceRanges: semanticAnalysis.activeSourceRanges,
      codeFenceHighlighters: codeFenceHighlighters(state),
      codeFenceLanguages,
      imageSourceResolver: state.facet(liveMdImageSourceResolver),
      linkBaseUrl: state.facet(liveMdLinkBaseUrl),
      markdownFeatures: state.facet(liveMdMarkdownFeatureFacet),
      sourceIslandMode: true,
      state,
      trace: semanticAnalysis.trace,
    });
    projectLeafRecords(build, semanticAnalysis.records);
    applyLegacyMarkdownFeatures(build, markdownParserService, tree);
    return {
      activeLines,
      activeSourceRanges: semanticAnalysis.activeSourceRanges,
      atomicRanges: finishAtomicRanges(build),
      decorations: finishDecorations(build),
      sourceIslandLeaves: semanticAnalysis.sourceIslandLeaves,
      trace: build.trace,
      tree,
    };
  }

  let build = buildLegacyLiveMdBuild(state, activeLines, codeFenceLanguages, null, tree);
  return {
    activeLines,
    activeSourceRanges: [],
    atomicRanges: finishAtomicRanges(build),
    decorations: finishDecorations(build),
    sourceIslandLeaves: [],
    trace: build.trace,
    tree,
  };
}

export function __testBuildLiveMdAnalysis(state: EditorState) {
  return buildLiveMdAnalysis(state);
}

export function __testBuildCanonicalLiveMdAnalysis(state: EditorState) {
  return buildCanonicalLiveMdAnalysis(state);
}

export function __testLiveMdAnalysis(view: EditorView): LiveMdAnalysis {
  return view.state.field(liveMdAnalysisField);
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
  return {
    activeLines,
    activeSourceRanges: markdownAnalysis?.activeSourceRanges ?? [],
    atomicRanges: finishAtomicRanges(build),
    decorations: finishDecorations(build),
    sourceIslandLeaves: markdownAnalysis?.leaves ?? [],
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
) {
  if (!build.markdownFeatures.length) return;
  withLiveMdMarkdownInlineTrees(markdownParserService, build.state.doc, tree, (inlineTrees) => {
    applyLiveMdMarkdownFeatures(build, inlineTrees);
  });
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
