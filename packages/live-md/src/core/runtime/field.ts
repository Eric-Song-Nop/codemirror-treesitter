import { EditorState, RangeSet, StateField, type Extension } from "@codemirror/state";
import {
  syntaxHighlighters,
  syntaxTree,
  type Highlighter,
  type Tree,
} from "@codemirror-treesitter/language";
import { EditorView } from "@codemirror/view";
import { isInsideSkippedRange, matchRoot, queryLiveMdMatches } from "../analysis/query.js";
import { collectTable } from "../analysis/tables.js";
import { type CapturedTable, type DocRange, type LiveMdAnalysis } from "../analysis/types.js";
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
} from "../languages.js";
import { liveMdLinkBaseUrl } from "../links.js";
import { createLiveMdBuild, finishAtomicRanges, finishDecorations } from "../projection/emit.js";
import { applyLiveMdMarkdownFeatures, processLiveMdMatch } from "../projection/builtin.js";

const defaultCodeFenceHighlighters = [liveMdDefaultCodeFenceHighlighter] as const;

const liveMdAnalysisField = StateField.define<LiveMdAnalysis>({
  create(state) {
    return buildLiveMdAnalysis(state, getActiveLines(state));
  },
  update(value, transaction) {
    let tree = syntaxTree(transaction.state);
    let activeLines = getActiveLines(transaction.state);
    if (
      tree == value.tree &&
      !transaction.docChanged &&
      sameNumbers(activeLines, value.activeLines) &&
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
  let build = buildLiveMdBuild(state, activeLines, codeFenceLanguages);
  return {
    activeLines,
    atomicRanges: finishAtomicRanges(build),
    codeFenceHighlightTrees: build.codeFenceHighlightTrees,
    decorations: finishDecorations(build),
    tree: syntaxTree(state),
  };
}

export function __testBuildLiveMdAnalysis(state: EditorState) {
  return buildLiveMdAnalysis(state);
}

export function __testLiveMdAnalysis(view: EditorView): LiveMdAnalysis {
  return view.state.field(liveMdAnalysisField);
}

function buildLiveMdBuild(
  state: EditorState,
  activeLines: Set<number>,
  codeFenceLanguages: CodeFenceLanguageMap,
) {
  let build = createLiveMdBuild({
    activeLines,
    codeFenceHighlighters: codeFenceHighlighters(state),
    codeFenceLanguages,
    imageSourceResolver: state.facet(liveMdImageSourceResolver),
    linkBaseUrl: state.facet(liveMdLinkBaseUrl),
    markdownFeatures: state.facet(liveMdMarkdownFeatureFacet),
    state,
  });

  let tree = syntaxTree(state);
  let markdownParserService = state.facet(liveMdMarkdownParserServiceFacet);
  if (markdownParserService) {
    withLiveMdMarkdownInlineTrees(markdownParserService, state.doc, tree, (inlineTrees) =>
      processMatches(build, queryLiveMdMatches(tree, inlineTrees), inlineTrees),
    );
    return build;
  }

  processMatches(build, queryLiveMdMatches(tree), []);

  return build;
}

function processMatches(
  build: ReturnType<typeof createLiveMdBuild>,
  matches: ReturnType<typeof queryLiveMdMatches>,
  inlineTrees: readonly Tree[],
) {
  let skipped: DocRange[] = [];
  let tables = new Map<string, CapturedTable>();
  for (let match of matches) {
    collectTable(match, tables);
  }
  let processed = new Set<string>();
  for (let match of matches) {
    let root = matchRoot(match);
    if (root && isInsideSkippedRange(root, skipped)) continue;
    if (processLiveMdMatch(build, match, tables, processed, skipped) === false && root) {
      skipped.push({ from: root.from, to: root.to });
    }
  }
  applyLiveMdMarkdownFeatures(build, inlineTrees);
}

function sameNumbers(left: ReadonlySet<number>, right: ReadonlySet<number>) {
  if (left.size != right.size) return false;
  for (let value of left) if (!right.has(value)) return false;
  return true;
}

function sameArrayItems<T>(left: readonly T[], right: readonly T[]) {
  if (left.length != right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] != right[index]) return false;
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
