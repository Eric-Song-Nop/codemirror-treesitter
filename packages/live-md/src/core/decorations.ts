import {
  type ChangeDesc,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  StateEffect,
  StateField,
  Text,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  compileTreeSitterQuery,
  highlightTree,
  queryTreeMatches,
  syntaxTree,
  type Highlighter,
  type SyntaxNode,
  type Tree,
  type TreeSitterParser,
  type TreeSitterQueryMatch,
} from "@codemirror-treesitter/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  codeFenceHighlighterFacet,
  codeFenceLanguagesField,
  emptyCodeFenceLanguages,
  type CodeFenceLanguageMap,
} from "./languages.js";
import {
  liveMdImageSourceResolver,
  resolveLiveMdImageSource,
  type LiveMdImageSourceResolver,
} from "./images.js";
import { liveMdLinkBaseUrl } from "./links.js";
import { forEachLineInRange, isWhitespaceOnly, splitRangeByLine } from "./util.js";
import {
  liveMdFeatureFacet,
  liveMdFeatures,
  type LiveMdFeature,
  type LiveMdFeatureContext,
  type LiveMdFeatureCreateContext,
  type LiveMdFeatureMatch,
  type LiveMdQueryTarget,
} from "./features.js";
import { liveMdDefaultFeatures } from "./default-features.js";

type LiveMdBuild = {
  activeLines: Set<number>;
  atomicRanges: Array<{ from: number; to: number }>;
  codeFenceHighlightTrees: CodeFenceHighlightTree[];
  codeFenceHighlighter: Highlighter;
  codeFenceLanguages: CodeFenceLanguageMap;
  decorations: Array<Range<Decoration>>;
  imageSourceResolver: LiveMdImageSourceResolver | null;
  lineClasses: Map<number, Set<string>>;
  linkBaseUrl: string | null;
  state: EditorState;
};

type DocRange = {
  from: number;
  to: number;
};

type PlannedLiveMdFeature = {
  feature: LiveMdFeature<unknown>;
  fromPattern: number;
  toPattern: number;
};

type LiveMdFeatureQueryPlan = {
  features: PlannedLiveMdFeature[];
  source: string;
  target: LiveMdQueryTarget;
};

type PlannedLiveMdFeatureMatch = LiveMdFeatureMatch & {
  feature: LiveMdFeature<unknown>;
};

type CodeFenceParser =
  CodeFenceLanguageMap extends ReadonlyMap<string, infer Parser> ? Parser : never;

type CodeFenceHighlightTree = {
  contentFrom: number;
  contentTo: number;
  language: string;
  parser: CodeFenceParser;
  sourceText: Text;
  tree: Tree;
};

const visibleSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" });
const hiddenSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-hidden" });

type LiveMdAnalysis = {
  activeLines: ReadonlySet<number>;
  atomicRanges: RangeSet<RangeValue>;
  codeFenceHighlightTrees: readonly CodeFenceHighlightTree[];
  codeFenceLanguages: CodeFenceLanguageMap;
  decorations: DecorationSet;
  ranges: readonly DocRange[];
  tree: Tree;
};

const setLiveMdAnalysisRanges = StateEffect.define<readonly DocRange[]>();

const liveMdAnalysisField = StateField.define<LiveMdAnalysis>({
  create(state) {
    return buildLiveMdAnalysis(state, getActiveLines(state), fullDocRange(state));
  },
  update(value, transaction) {
    let ranges = transaction.docChanged
      ? mapDocRanges(value.ranges, transaction.changes, transaction.state)
      : value.ranges;
    let rangesChanged = false;
    for (let effect of transaction.effects) {
      if (effect.is(setLiveMdAnalysisRanges)) {
        ranges = effect.value;
        rangesChanged = !sameDocRanges(ranges, value.ranges);
      }
    }

    let tree = syntaxTree(transaction.state);
    if (
      !rangesChanged &&
      tree == value.tree &&
      !transaction.docChanged &&
      !transaction.selection &&
      transaction.startState.facet(codeFenceHighlighterFacet) ==
        transaction.state.facet(codeFenceHighlighterFacet) &&
      !codeFenceLanguagesChanged(transaction.startState, transaction.state) &&
      transaction.startState.facet(liveMdImageSourceResolver) ==
        transaction.state.facet(liveMdImageSourceResolver) &&
      transaction.startState.facet(liveMdLinkBaseUrl) ==
        transaction.state.facet(liveMdLinkBaseUrl) &&
      !liveMdFeaturesChanged(transaction.startState, transaction.state)
    ) {
      return value;
    }

    return buildLiveMdAnalysis(transaction.state, getActiveLines(transaction.state), ranges);
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

class LiveMdViewportPlugin {
  private destroyed = false;
  private pending = false;

  constructor(readonly view: EditorView) {
    this.scheduleSync();
  }

  update(update: ViewUpdate) {
    if (update.viewportChanged || update.docChanged) this.scheduleSync();
  }

  private scheduleSync() {
    if (this.pending) return;
    this.pending = true;
    this.view.requestMeasure({
      read: () => null,
      write: () => {
        this.pending = false;
        setTimeout(() => {
          if (this.destroyed) return;
          let ranges = visibleLineRanges(this.view);
          let current = this.view.state.field(liveMdAnalysisField, false);
          if (!current || sameDocRanges(ranges, current.ranges)) return;
          this.view.dispatch({ effects: setLiveMdAnalysisRanges.of(ranges) });
        }, 0);
      },
    });
  }

  destroy() {
    this.destroyed = true;
  }
}

const liveMdViewportPlugin = ViewPlugin.fromClass(LiveMdViewportPlugin);

class AtomicRange extends RangeValue {
  eq(other: RangeValue) {
    return other instanceof AtomicRange;
  }
}

const paragraphBreakAtom = new AtomicRange();

function createLiveMdBuild(
  state: EditorState,
  activeLines: Set<number>,
  codeFenceLanguages: CodeFenceLanguageMap,
): LiveMdBuild {
  return {
    activeLines,
    atomicRanges: [],
    codeFenceHighlightTrees: [],
    codeFenceHighlighter: state.facet(codeFenceHighlighterFacet),
    codeFenceLanguages,
    decorations: [],
    imageSourceResolver: state.facet(liveMdImageSourceResolver),
    lineClasses: new Map(),
    linkBaseUrl: state.facet(liveMdLinkBaseUrl),
    state,
  };
}

function createLiveMdFeatureContext(build: LiveMdBuild): LiveMdFeatureContext {
  let claimed = new Set<string>();
  let consumed: Array<{ from: number; to: number }> = [];

  return {
    activeLines: build.activeLines,
    atomic: (from, to) => addAtom(build, from, to),
    capture,
    captures,
    claim(key) {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    consume(from, to) {
      if (from < to) consumed.push({ from, to });
    },
    isConsumed(from, to) {
      return consumed.some((range) => from >= range.from && to <= range.to);
    },
    highlightCodeFence: (contentFrom, contentTo, language) =>
      addCodeFenceHighlights(build, contentFrom, contentTo, language),
    lineClass: (from, to, className) => addLineRangeClass(build, from, to, className),
    lineClassAt: (lineNumber, className) => addLineClass(build, lineNumber, className),
    linkBaseUrl: build.linkBaseUrl,
    mark: (from, to, decoration) => addMark(build, from, to, decoration),
    nodeKey,
    onlyVisibleContentOnLine: (lineFrom, lineTo, contentFrom, contentTo) =>
      isOnlyVisibleContentOnLine(build.state, lineFrom, lineTo, contentFrom, contentTo),
    replace: (from, to, widget, block = false) => addReplace(build, from, to, widget, block),
    resolveImageSource: (source) => resolveLiveMdImageSource(source, build.imageSourceResolver),
    state: build.state,
    syntax: (from, to, decoration) => addSyntax(build, from, to, decoration),
    text: (node) => build.state.sliceDoc(node.from, node.to),
    touchesActiveLine: (from, to) => rangeTouchesActiveLine(build, from, to),
  };
}

function createLiveMdFeatureStates(
  features: readonly LiveMdFeature[],
  context: LiveMdFeatureCreateContext,
) {
  let states = new Map<LiveMdFeature<unknown>, unknown>();
  for (let feature of features) {
    states.set(feature as LiveMdFeature<unknown>, feature.create?.(context));
  }
  return states;
}

function isMatchConsumed(match: LiveMdFeatureMatch, context: LiveMdFeatureContext) {
  return (
    match.captures.length > 0 &&
    match.captures.every((item) => context.isConsumed(item.node.from, item.node.to))
  );
}

function addLineClass(build: LiveMdBuild, lineNumber: number, className: string) {
  let classes = build.lineClasses.get(lineNumber);
  if (!classes) build.lineClasses.set(lineNumber, (classes = new Set()));
  classes.add(className);
}

function addLineRangeClass(build: LiveMdBuild, from: number, to: number, className: string) {
  forEachLineInRange(build.state, from, to, (docLine) =>
    addLineClass(build, docLine.number, className),
  );
}

function addAtom(build: LiveMdBuild, from: number, to: number) {
  if (from < to) build.atomicRanges.push({ from, to });
}

function addMark(build: LiveMdBuild, from: number, to: number, decoration: Decoration) {
  if (from < to) build.decorations.push(decoration.range(from, to));
}

function addMarkByLine(
  build: LiveMdBuild,
  from: number,
  to: number,
  decorationForLine: (lineNumber: number) => Decoration,
) {
  splitRangeByLine(build.state, from, to, (lineNumber, rangeFrom, rangeTo) => {
    addMark(build, rangeFrom, rangeTo, decorationForLine(lineNumber));
  });
}

function addReplace(
  build: LiveMdBuild,
  from: number,
  to: number,
  widget: WidgetType,
  block = false,
) {
  addMark(build, from, to, Decoration.replace({ block, widget }));
}

function addSyntax(build: LiveMdBuild, from: number, to: number, decoration?: Decoration) {
  addMarkByLine(build, from, to, (lineNumber) => {
    if (decoration) return decoration;
    return build.activeLines.has(lineNumber) ? visibleSyntax : hiddenSyntax;
  });
}

function finishDecorations(build: LiveMdBuild) {
  let lineDecorations = new RangeSetBuilder<Decoration>();
  let lineClasses = Array.from(build.lineClasses).sort(
    ([leftLine], [rightLine]) => leftLine - rightLine,
  );
  for (let [lineNumber, classes] of lineClasses) {
    let docLine = build.state.doc.line(lineNumber);
    lineDecorations.add(
      docLine.from,
      docLine.from,
      Decoration.line({ class: [...classes].join(" ") }),
    );
  }
  return RangeSet.join([lineDecorations.finish(), RangeSet.of(build.decorations, true)]);
}

function finishAtomicRanges(build: LiveMdBuild) {
  let builder = new RangeSetBuilder<RangeValue>();
  build.atomicRanges.sort((left, right) => left.from - right.from || left.to - right.to);
  for (let { from, to } of build.atomicRanges) {
    builder.add(from, to, paragraphBreakAtom);
  }
  return builder.finish();
}

function buildLiveMdAnalysis(
  state: EditorState,
  activeLines = getActiveLines(state),
  ranges: readonly DocRange[] = fullDocRange(state),
): LiveMdAnalysis {
  let codeFenceLanguages = state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages;
  let build = buildLiveMdBuild(
    state,
    activeLines,
    codeFenceLanguages,
    expandLeadingBlankRanges(state, ranges),
  );
  return {
    activeLines,
    atomicRanges: finishAtomicRanges(build),
    codeFenceHighlightTrees: build.codeFenceHighlightTrees,
    codeFenceLanguages,
    decorations: finishDecorations(build),
    ranges,
    tree: syntaxTree(state),
  };
}

export function __testBuildLiveMdAnalysis(state: EditorState) {
  return buildLiveMdAnalysis(state);
}

export function __testBuildVisibleLiveMdAnalysis(state: EditorState, ranges: readonly DocRange[]) {
  return buildLiveMdAnalysis(state, getActiveLines(state), ranges);
}

export function __testLiveMdAnalysis(view: EditorView): LiveMdAnalysis {
  return view.state.field(liveMdAnalysisField);
}

export function __testVisibleLineRanges(view: EditorView): readonly DocRange[] {
  return visibleLineRanges(view);
}

function buildLiveMdBuild(
  state: EditorState,
  activeLines: Set<number>,
  codeFenceLanguages: CodeFenceLanguageMap,
  ranges: readonly DocRange[],
) {
  let build = createLiveMdBuild(state, activeLines, codeFenceLanguages);
  let features = state.facet(liveMdFeatureFacet);

  let tree = syntaxTree(state);
  let matches = queryLiveMdFeatureMatches(tree, features, ranges);
  let context = createLiveMdFeatureContext(build);
  let featureStates = createLiveMdFeatureStates(features, context);

  for (let match of matches) {
    match.feature.collect?.(match, featureStates.get(match.feature), context);
  }

  for (let match of matches) {
    if (isMatchConsumed(match, context)) continue;
    match.feature.apply?.(match, featureStates.get(match.feature), context);
  }

  for (let feature of features) {
    feature.finish?.(featureStates.get(feature), context);
  }

  return build;
}

function queryLiveMdFeatureMatches(
  tree: Tree,
  features: readonly LiveMdFeature[],
  ranges: readonly DocRange[],
) {
  let matches: PlannedLiveMdFeatureMatch[] = [];
  for (let { from, to } of ranges) {
    let options = from <= 0 && to >= tree.length ? undefined : { from, to };
    let plans = new WeakMap<Tree, LiveMdFeatureQueryPlan>();
    let source = (parser: TreeSitterParser, queryTree: Tree) => {
      let plan = liveMdFeatureQueryPlan(parser, queryTree, features);
      if (!plan) return null;
      plans.set(queryTree, plan);
      return plan.source;
    };
    for (let match of queryTreeMatches(tree, source, options)) {
      let plan = matchPlan(match, plans);
      if (!plan) continue;
      let feature = planFeature(plan, match.patternIndex);
      if (!feature) continue;
      matches.push({
        ...match,
        feature: feature.feature,
        patternIndex: match.patternIndex - feature.fromPattern,
        target: plan.target,
      });
    }
  }
  return matches;
}

function liveMdFeatureQueryPlan(
  parser: TreeSitterParser,
  tree: Tree,
  features: readonly LiveMdFeature[],
): LiveMdFeatureQueryPlan | null {
  let target = liveMdQueryTarget(tree);
  if (!target) return null;

  let offset = 0;
  let sources: string[] = [];
  let plannedFeatures: PlannedLiveMdFeature[] = [];
  for (let feature of features) {
    let source = feature.query?.[target]?.trim();
    if (!source) continue;

    let patternCount = compileTreeSitterQuery(parser, source).patternCount();
    if (patternCount <= 0) continue;

    sources.push(source);
    plannedFeatures.push({
      feature: feature as LiveMdFeature<unknown>,
      fromPattern: offset,
      toPattern: offset + patternCount,
    });
    offset += patternCount;
  }

  if (!sources.length) return null;
  return {
    features: plannedFeatures,
    source: sources.join("\n\n"),
    target,
  };
}

function liveMdQueryTarget(tree: Tree): LiveMdQueryTarget | null {
  if (tree.topNode.name == "document") return "document";
  if (tree.topNode.name == "inline") return "inline";
  return null;
}

function matchPlan(match: TreeSitterQueryMatch, plans: WeakMap<Tree, LiveMdFeatureQueryPlan>) {
  let tree = match.captures[0]?.node.tree;
  return tree ? (plans.get(tree) ?? null) : null;
}

function planFeature(plan: LiveMdFeatureQueryPlan, patternIndex: number) {
  return (
    plan.features.find(
      (feature) => patternIndex >= feature.fromPattern && patternIndex < feature.toPattern,
    ) ?? null
  );
}

function fullDocRange(state: EditorState): readonly DocRange[] {
  return [{ from: 0, to: state.doc.length }];
}

function visibleLineRanges(view: EditorView): readonly DocRange[] {
  if (view.scrollDOM.clientHeight == 0) return fullDocRange(view.state);
  if (!rangesCoverSelection(view.visibleRanges, view.state)) return fullDocRange(view.state);

  let ranges: DocRange[] = [];
  for (let range of view.visibleRanges) {
    let from = clamp(range.from, 0, view.state.doc.length);
    let to = clamp(range.to, 0, view.state.doc.length);
    if (from > to) continue;
    let firstLine = view.state.doc.lineAt(from);
    let lastLine = view.state.doc.lineAt(Math.max(from, to - 1));
    let lineRange = { from: firstLine.from, to: to >= view.state.doc.length ? to : lastLine.to };
    let last = ranges[ranges.length - 1];
    if (last && lineRange.from <= last.to) {
      last.to = Math.max(last.to, lineRange.to);
    } else {
      ranges.push(lineRange);
    }
  }
  return ranges;
}

function rangesCoverSelection(ranges: readonly DocRange[], state: EditorState) {
  for (let selectionRange of state.selection.ranges) {
    let head = selectionRange.head;
    if (!ranges.some((range) => head >= range.from && head <= range.to)) return false;
  }
  return true;
}

function mapDocRanges(ranges: readonly DocRange[], changes: ChangeDesc, state: EditorState) {
  return mergeDocRanges(
    ranges.map((range) =>
      lineRangeFor(state, changes.mapPos(range.from, -1), changes.mapPos(range.to, 1)),
    ),
  );
}

function expandLeadingBlankRanges(state: EditorState, ranges: readonly DocRange[]) {
  return mergeDocRanges(ranges.map((range) => expandLeadingBlankRange(state, range)));
}

function expandLeadingBlankRange(state: EditorState, range: DocRange): DocRange {
  if (range.from <= 0 || state.doc.length == 0) return range;
  let from = clamp(range.from, 0, state.doc.length);
  let to = clamp(range.to, 0, state.doc.length);
  let firstLine = state.doc.lineAt(Math.min(from, state.doc.length));
  if (!isWhitespaceOnly(state.sliceDoc(firstLine.from, firstLine.to))) return { from, to };

  let lineNumber = firstLine.number - 1;
  for (; lineNumber >= 1; lineNumber--) {
    let line = state.doc.line(lineNumber);
    from = line.from;
    if (!isWhitespaceOnly(state.sliceDoc(line.from, line.to))) break;
  }
  for (lineNumber--; lineNumber >= 1; lineNumber--) {
    let line = state.doc.line(lineNumber);
    if (isWhitespaceOnly(state.sliceDoc(line.from, line.to))) break;
    from = line.from;
  }
  return { from, to };
}

function lineRangeFor(state: EditorState, from: number, to: number): DocRange {
  let rangeFrom = clamp(from, 0, state.doc.length);
  let rangeTo = clamp(to, 0, state.doc.length);
  let firstLine = state.doc.lineAt(rangeFrom);
  let lastLine = state.doc.lineAt(Math.max(rangeFrom, rangeTo - 1));
  return { from: firstLine.from, to: rangeTo >= state.doc.length ? rangeTo : lastLine.to };
}

function sameDocRanges(left: readonly DocRange[], right: readonly DocRange[]) {
  if (left.length != right.length) return false;
  for (let index = 0; index < left.length; index++) {
    let leftRange = left[index]!;
    let rightRange = right[index]!;
    if (leftRange.from != rightRange.from || leftRange.to != rightRange.to) return false;
  }
  return true;
}

function mergeDocRanges(ranges: readonly DocRange[]) {
  let sorted = ranges.slice().sort((left, right) => left.from - right.from || left.to - right.to);
  let merged: DocRange[] = [];
  for (let range of sorted) {
    let last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function codeFenceLanguagesChanged(startState: EditorState, state: EditorState) {
  return (
    startState.field(codeFenceLanguagesField, false) != state.field(codeFenceLanguagesField, false)
  );
}

function liveMdFeaturesChanged(startState: EditorState, state: EditorState) {
  let startFeatures = startState.facet(liveMdFeatureFacet);
  let features = state.facet(liveMdFeatureFacet);
  if (startFeatures == features) return false;
  if (startFeatures.length != features.length) return true;
  for (let index = 0; index < features.length; index++) {
    if (startFeatures[index] != features[index]) return true;
  }
  return false;
}

function getActiveLines(state: EditorState) {
  let lines = new Set<number>();
  for (let range of state.selection.ranges) {
    lines.add(state.doc.lineAt(range.head).number);
  }
  return lines;
}

function capture(match: TreeSitterQueryMatch, name: string) {
  return match.captures.find((item) => item.name == name) ?? null;
}

function captures(match: TreeSitterQueryMatch, name: string) {
  return match.captures.filter((item) => item.name == name);
}

function nodeKey(node: SyntaxNode) {
  return `${node.name}:${node.id}:${node.from}:${node.to}`;
}

function addCodeFenceHighlights(
  build: LiveMdBuild,
  contentFrom: number,
  contentTo: number,
  language: string,
) {
  let highlight = getCodeFenceHighlight(build, contentFrom, contentTo, language);
  if (!highlight) return;

  let { sourceText, tree } = highlight;

  highlightTree(
    tree,
    build.codeFenceHighlighter,
    (from, to, className) => {
      let decoration = Decoration.mark({ class: className });
      splitTextRangeByLine(sourceText, from, to, (rangeFrom, rangeTo) => {
        addMark(build, contentFrom + rangeFrom, contentFrom + rangeTo, decoration);
      });
    },
    0,
    sourceText.length,
  );
}

function getCodeFenceHighlight(
  build: LiveMdBuild,
  contentFrom: number,
  contentTo: number,
  language: string,
) {
  let parser = build.codeFenceLanguages.get(language);
  if (!parser || contentFrom >= contentTo) return null;

  let sourceText = codeFenceSourceText(build.state, contentFrom, contentTo);
  let tree = parser.parse(sourceText);
  let highlight = {
    contentFrom,
    contentTo,
    language,
    parser,
    sourceText,
    tree,
  };
  build.codeFenceHighlightTrees.push(highlight);
  return highlight;
}

function codeFenceSourceText(state: EditorState, contentFrom: number, contentTo: number) {
  return Text.of(state.sliceDoc(contentFrom, contentTo).split("\n"));
}

function splitTextRangeByLine(
  text: Text,
  from: number,
  to: number,
  visit: (from: number, to: number) => void,
) {
  let cursor = from;
  while (cursor < to) {
    let line = text.lineAt(cursor);
    let rangeTo = Math.min(to, line.to);
    if (cursor < rangeTo) visit(cursor, rangeTo);
    cursor = line.to < to ? line.to + 1 : to;
  }
}

function rangeTouchesActiveLine(build: LiveMdBuild, from: number, to: number) {
  let firstLine = build.state.doc.lineAt(from).number;
  let lastLine = build.state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber of build.activeLines) {
    if (lineNumber >= firstLine && lineNumber <= lastLine) return true;
  }
  return false;
}

function isOnlyVisibleContentOnLine(
  state: EditorState,
  lineFrom: number,
  lineTo: number,
  contentFrom: number,
  contentTo: number,
) {
  return (
    isWhitespaceOnly(state.sliceDoc(lineFrom, contentFrom)) &&
    isWhitespaceOnly(state.sliceDoc(contentTo, lineTo))
  );
}

export const liveMdAnalysis: Extension = [
  liveMdFeatures(liveMdDefaultFeatures),
  liveMdAnalysisField,
  liveMdViewportPlugin,
];
