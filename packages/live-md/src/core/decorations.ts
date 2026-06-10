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
import { forEachLineInRange, isWhitespace, isWhitespaceOnly, splitRangeByLine } from "./util.js";
import { liveMdLinkBaseUrl, liveMdLinkMark } from "./links.js";
import {
  liveMdFeatureFacet,
  liveMdFeatures,
  type LiveMdFeature,
  type LiveMdFeatureContext,
  type LiveMdFeatureCreateContext,
  type LiveMdFeatureMatch,
  type LiveMdQueryTarget,
} from "./features.js";
import {
  ImagePreviewWidget,
  LatexWidget,
  ListMarkerWidget,
  MermaidWidget,
  TablePreviewWidget,
  TaskCheckboxWidget,
  type LatexFormula,
  type MermaidDiagram,
  type MarkdownTable,
} from "./widgets.js";

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
const strongMark = Decoration.mark({ class: "cm-md-strong" });
const emphasisMark = Decoration.mark({ class: "cm-md-emphasis" });
const strikeMark = Decoration.mark({ class: "cm-md-strike" });
const inlineCodeMark = Decoration.mark({ class: "cm-md-inline-code" });
const tablePipeMark = Decoration.mark({ class: "cm-md-table-pipe" });

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

type ParagraphContainerKind = "block" | "document" | "list" | "listItem";

type ParagraphContainer = {
  children: SyntaxNode[];
  kind: ParagraphContainerKind;
  node: SyntaxNode;
};

type CapturedTable = {
  delimiterCells: Map<string, CapturedTableDelimiterCell>;
  delimiterRow: SyntaxNode | null;
  headerCells: Map<string, SyntaxNode>;
  node: SyntaxNode;
  pipes: Map<string, SyntaxNode>;
  rows: Map<string, CapturedTableRow>;
};

type CapturedTableDelimiterCell = {
  left: boolean;
  node: SyntaxNode;
  right: boolean;
};

type CapturedTableRow = {
  cells: Map<string, SyntaxNode>;
  node: SyntaxNode;
};

function collectParagraphContainer(
  match: TreeSitterQueryMatch,
  containers: Map<string, ParagraphContainer>,
) {
  let containerCapture = capture(match, "paragraph.container");
  let childCapture = capture(match, "paragraph.child");
  let kind = match.setProperties?.["paragraph.kind"];
  if (!containerCapture || !childCapture || typeof kind != "string") return;
  if (!isParagraphContainerKind(kind)) return;

  let key = nodeKey(containerCapture.node);
  let container = containers.get(key);
  if (!container) {
    container = { children: [], kind, node: containerCapture.node };
    containers.set(key, container);
  }
  container.children.push(childCapture.node);
}

function collectTable(match: TreeSitterQueryMatch, tables: Map<string, CapturedTable>) {
  let tableCapture = capture(match, "table");
  if (!tableCapture) return;
  let table = capturedTable(tables, tableCapture.node);
  for (let headerCell of captures(match, "table.header.cell")) {
    table.headerCells.set(nodeKey(headerCell.node), headerCell.node);
  }
  for (let delimiterRow of captures(match, "table.delimiter.row")) {
    table.delimiterRow = delimiterRow.node;
  }
  for (let delimiterCell of captures(match, "table.delimiter.cell")) {
    let key = nodeKey(delimiterCell.node);
    table.delimiterCells.set(key, {
      left: !!capture(match, "table.align.left"),
      node: delimiterCell.node,
      right: !!capture(match, "table.align.right"),
    });
  }
  for (let rowCapture of captures(match, "table.row")) {
    capturedTableRow(table, rowCapture.node);
  }
  let rowCapture = capture(match, "table.row");
  for (let rowCell of captures(match, "table.row.cell")) {
    let row = rowCapture ? capturedTableRow(table, rowCapture.node) : null;
    row?.cells.set(nodeKey(rowCell.node), rowCell.node);
  }
  for (let pipe of captures(match, "table.pipe")) {
    table.pipes.set(nodeKey(pipe.node), pipe.node);
  }
}

function capturedTable(tables: Map<string, CapturedTable>, node: SyntaxNode) {
  let key = nodeKey(node);
  let table = tables.get(key);
  if (!table) {
    table = {
      delimiterCells: new Map(),
      delimiterRow: null,
      headerCells: new Map(),
      node,
      pipes: new Map(),
      rows: new Map(),
    };
    tables.set(key, table);
  }
  return table;
}

function capturedTableRow(table: CapturedTable, node: SyntaxNode) {
  let key = nodeKey(node);
  let row = table.rows.get(key);
  if (!row) {
    row = { cells: new Map(), node };
    table.rows.set(key, row);
  }
  return row;
}

function markParagraphBreaks(
  context: LiveMdFeatureContext,
  containers: ReadonlyMap<string, ParagraphContainer>,
) {
  for (let container of containers.values()) {
    if (container.kind == "listItem") continue;
    let siblings = sortedNodes(container.children);
    let previousFrom =
      container.kind == "list"
        ? (node: SyntaxNode) => blockContainerBreakFrom(context, node, containers)
        : (node: SyntaxNode) => blockBreakFrom(context, node);
    for (let index = 1; index < siblings.length; index++) {
      markParagraphBreakRun(context, previousFrom(siblings[index - 1]!), siblings[index]!.from);
    }
    let last = siblings.at(-1);
    if (last) markParagraphBreakRun(context, previousFrom(last), container.node.to);
  }
}

function blockBreakFrom(context: LiveMdFeatureContext, node: SyntaxNode): number {
  if (node.to <= node.from) return node.to;
  let before = node.to - 1;
  if (context.state.sliceDoc(before, node.to) != "\n") return node.to;
  return context.state.doc.lineAt(before).to;
}

function blockContainerBreakFrom(
  context: LiveMdFeatureContext,
  node: SyntaxNode,
  containers: ReadonlyMap<string, ParagraphContainer>,
) {
  let blocks = sortedNodes(containers.get(nodeKey(node))?.children);
  return blocks.length ? blockBreakFrom(context, blocks[blocks.length - 1]!) : node.to;
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

function isParagraphContainerKind(kind: string): kind is ParagraphContainerKind {
  switch (kind) {
    case "block":
    case "document":
    case "list":
    case "listItem":
      return true;
    default:
      return false;
  }
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

function sortedNodes(nodes?: Iterable<SyntaxNode>) {
  return Array.from(nodes ?? []).sort(compareNodes);
}

function compareNodes(left: SyntaxNode, right: SyntaxNode) {
  return left.from - right.from || left.to - right.to || left.name.localeCompare(right.name);
}

function markParagraphBreakRun(context: LiveMdFeatureContext, from: number, to: number) {
  if (from >= to || !isWhitespaceOnly(context.state.sliceDoc(from, to))) return;

  let newlinePositions: number[] = [];
  let source = context.state.sliceDoc(from, to);
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) == 10) newlinePositions.push(from + index);
  }

  let separatorCount = Math.floor(newlinePositions.length / 2);
  if (!separatorCount) return;

  let blankLines: number[] = [];
  forEachLineInRange(context.state, from, to, (line) => {
    if (line.from > from && isWhitespaceOnly(context.state.sliceDoc(line.from, line.to))) {
      blankLines.push(line.number);
    }
  });

  for (let index = 0; index < separatorCount; index++) {
    context.atomic(newlinePositions[index * 2]!, newlinePositions[index * 2 + 1]! + 1);

    let separatorLine = blankLines[index * 2];
    if (separatorLine == null) return;
    context.lineClassAt(separatorLine, "cm-md-block-separator");
  }
}

function applyHeadingMatch(context: LiveMdFeatureContext, match: LiveMdFeatureMatch) {
  let node = capture(match, "heading")?.node;
  if (!node) return;
  let level = Number(match.setProperties?.["heading.level"]) || 1;
  applyHeading(context, node, level, capture(match, "heading.marker")?.node);
}

function applyHeading(
  context: LiveMdFeatureContext,
  node: SyntaxNode,
  level: number,
  marker?: SyntaxNode,
) {
  context.lineClass(node.from, node.to, "cm-md-heading");
  context.lineClass(node.from, node.to, `cm-md-heading-${level}`);
  if (marker) context.syntax(marker.from, marker.to);
}

function applyListMarker(context: LiveMdFeatureContext, node: SyntaxNode) {
  let line = context.state.doc.lineAt(node.from);
  context.lineClassAt(line.number, "cm-md-list-line");
  if (context.activeLines.has(line.number)) {
    context.syntax(node.from, node.to);
  } else {
    context.replace(
      node.from,
      node.to,
      new ListMarkerWidget(context.state.sliceDoc(node.from, node.to).trim()),
    );
  }
}

function applyTaskMarker(context: LiveMdFeatureContext, node: SyntaxNode, checked: boolean) {
  let line = context.state.doc.lineAt(node.from);
  context.lineClassAt(line.number, "cm-md-list-line");
  context.lineClassAt(line.number, "cm-md-task-line");
  if (checked) context.lineClassAt(line.number, "is-checked");
  context.replace(node.from, node.to, new TaskCheckboxWidget(checked));
}

function applyRule(context: LiveMdFeatureContext, node: SyntaxNode) {
  context.lineClass(node.from, node.to, "cm-md-rule-line");
  context.syntax(node.from, node.to);
  context.consume(node.from, node.to);
}

function applyInlineLink(context: LiveMdFeatureContext, match: LiveMdFeatureMatch) {
  let node = capture(match, "link")?.node;
  let text = capture(match, "link.text")?.node;
  let destination = capture(match, "link.destination")?.node;
  if (!node) return;
  if (!text) return;
  context.syntax(node.from, text.from);
  context.mark(
    text.from,
    text.to,
    liveMdLinkMark(
      destination ? context.state.sliceDoc(destination.from, destination.to) : null,
      context.linkBaseUrl,
    ),
  );
  context.syntax(text.to, node.to);
}

function applyUriAutolink(context: LiveMdFeatureContext, node: SyntaxNode) {
  if (node.to - node.from <= 2) return;
  context.syntax(node.from, node.from + 1);
  context.mark(
    node.from + 1,
    node.to - 1,
    liveMdLinkMark(context.state.sliceDoc(node.from + 1, node.to - 1), context.linkBaseUrl),
  );
  context.syntax(node.to - 1, node.to);
}

function applyImage(context: LiveMdFeatureContext, match: LiveMdFeatureMatch) {
  let node = capture(match, "image")?.node;
  if (!node) return;
  let description = capture(match, "image.description")?.node;
  let destination = capture(match, "image.destination")?.node;
  let alt = description ? context.state.sliceDoc(description.from, description.to) : "";
  let src = destination ? context.state.sliceDoc(destination.from, destination.to).trim() : "";
  if (!src) return;

  let line = context.state.doc.lineAt(node.from);
  let active = context.activeLines.has(line.number);
  let widget = new ImagePreviewWidget(alt, context.resolveImageSource(src));
  if (!active && context.onlyVisibleContentOnLine(line.from, line.to, node.from, node.to)) {
    context.replace(line.from, line.to, widget, true);
    context.consume(line.from, line.to);
    return;
  }

  if (!active) {
    context.replace(node.from, node.to, widget);
    context.consume(node.from, node.to);
    return;
  }

  if (description) {
    context.syntax(node.from, description.from);
    context.mark(description.from, description.to, liveMdLinkMark(null, context.linkBaseUrl));
    context.syntax(description.to, node.to);
  }
  context.consume(node.from, node.to);
}

function applyLatex(context: LiveMdFeatureContext, match: LiveMdFeatureMatch) {
  let node = capture(match, "latex")?.node;
  let openingDelimiter = capture(match, "latex.open")?.node;
  let closingDelimiter = capture(match, "latex.close")?.node;
  if (!node || !openingDelimiter || !closingDelimiter) return;
  let formula = readLatexFormula(context.state, node, openingDelimiter, closingDelimiter);
  if (!formula) return;
  if (context.touchesActiveLine(node.from, node.to)) return;

  let range = latexReplacementRange(context.state, node, formula.displayMode);
  context.replace(
    range.from,
    range.to,
    new LatexWidget({ ...formula, block: range.block }),
    range.block,
  );
  context.consume(range.from, range.to);
}

function applyTable(
  context: LiveMdFeatureContext,
  match: LiveMdFeatureMatch,
  tables: ReadonlyMap<string, CapturedTable>,
) {
  let tableCapture = capture(match, "table");
  if (!tableCapture) return;
  let node = tableCapture.node;
  let key = `table:${nodeKey(node)}`;
  if (!context.claim(key)) return;

  let captured = tables.get(nodeKey(node));
  let table = captured ? readTableFromCaptures(context.state, captured) : null;
  if (table && !tableTouchesActiveLine(context, node.from, node.to, table)) {
    context.replace(node.from, node.to, new TablePreviewWidget(table), true);
    context.consume(node.from, node.to);
    return;
  }

  context.lineClass(node.from, node.to, "cm-md-table-line");
  if (captured?.delimiterRow) {
    context.lineClass(captured.delimiterRow.from, captured.delimiterRow.to, "cm-md-table-divider");
  }
  for (let pipe of sortedNodes(captured?.pipes.values())) {
    context.syntax(pipe.from, pipe.to, tablePipeMark);
  }
  context.consume(node.from, node.to);
}

function applyCodeFence(context: LiveMdFeatureContext, match: LiveMdFeatureMatch) {
  let node = capture(match, "codeFence")?.node;
  let openingDelimiter = capture(match, "codeFence.open")?.node;
  if (!node || !openingDelimiter) return;

  let closingDelimiter = capture(match, "codeFence.close")?.node ?? null;
  let content = capture(match, "codeFence.content")?.node;
  let language = readFenceLanguage(context.state, capture(match, "codeFence.language")?.node);

  if (content && content.from < content.to) {
    let diagram = readMermaidDiagram(context.state, content, language);
    if (diagram && !context.touchesActiveLine(node.from, node.to)) {
      context.replace(node.from, node.to, new MermaidWidget(diagram), true);
      context.consume(node.from, node.to);
      return;
    }
  }

  let openingLineNumber = context.state.doc.lineAt(openingDelimiter.from).number;
  let blockEndLineNumber = openingLineNumber;

  context.lineClassAt(openingLineNumber, "cm-md-code-fence-line");
  context.lineClassAt(openingLineNumber, "cm-md-code-block-start");
  context.syntax(openingDelimiter.from, openingDelimiter.to);

  if (content && content.from < content.to) {
    forEachLineInRange(context.state, content.from, content.to, (line) => {
      context.lineClassAt(line.number, "cm-md-code-line");
      blockEndLineNumber = line.number;
    });
    context.highlightCodeFence(content.from, content.to, language);
  }

  if (closingDelimiter) {
    let closingLineNumber = context.state.doc.lineAt(closingDelimiter.from).number;
    blockEndLineNumber = closingLineNumber;
    context.lineClassAt(closingLineNumber, "cm-md-code-fence-line");
    context.syntax(closingDelimiter.from, closingDelimiter.to);
  }

  context.lineClassAt(blockEndLineNumber, "cm-md-code-block-end");
  context.consume(node.from, node.to);
}

function readLatexFormula(
  state: EditorState,
  node: SyntaxNode,
  openingDelimiter: SyntaxNode,
  closingDelimiter: SyntaxNode,
): Omit<LatexFormula, "block"> | null {
  if (!openingDelimiter || !closingDelimiter || openingDelimiter == closingDelimiter) return null;

  let source = state.sliceDoc(node.from, node.to);
  let opening = state.sliceDoc(openingDelimiter.from, openingDelimiter.to);
  let closing = state.sliceDoc(closingDelimiter.from, closingDelimiter.to);
  let tex = state.sliceDoc(openingDelimiter.to, closingDelimiter.from).trim();
  if (!tex) return null;

  return {
    displayMode: opening.length > 1 || closing.length > 1 || tex.includes("\n"),
    source,
    tex,
  };
}

function latexReplacementRange(state: EditorState, node: SyntaxNode, displayMode: boolean) {
  if (!displayMode) return { block: false, from: node.from, to: node.to };

  let firstLine = state.doc.lineAt(node.from);
  let lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1));
  if (
    isWhitespaceOnly(state.sliceDoc(firstLine.from, node.from)) &&
    isWhitespaceOnly(state.sliceDoc(node.to, lastLine.to))
  ) {
    return { block: true, from: firstLine.from, to: lastLine.to };
  }

  return { block: false, from: node.from, to: node.to };
}

function readTableFromCaptures(state: EditorState, table: CapturedTable): MarkdownTable | null {
  let header = sortedNodes(table.headerCells.values()).map((cell) => tableCellText(state, cell));
  let alignments = Array.from(table.delimiterCells.values())
    .sort((left, right) => compareNodes(left.node, right.node))
    .map(tableAlignment);
  if (header.length < 2 || alignments.length < 2) return null;

  let columnCount = Math.max(header.length, alignments.length);
  return {
    alignments: normalizeTableAlignments(alignments, columnCount),
    header: normalizeTableCells(header, columnCount),
    rows: Array.from(table.rows.values())
      .sort((left, right) => compareNodes(left.node, right.node))
      .map((row) =>
        normalizeTableCells(
          sortedNodes(row.cells.values()).map((cell) => tableCellText(state, cell)),
          columnCount,
        ),
      ),
  };
}

function tableCellText(state: EditorState, node: SyntaxNode) {
  return state.sliceDoc(node.from, node.to).trim();
}

function tableAlignment(cell: CapturedTableDelimiterCell): "center" | "default" | "left" | "right" {
  if (cell.left && cell.right) return "center";
  if (cell.right) return "right";
  if (cell.left) return "left";
  return "default";
}

function readFenceLanguage(state: EditorState, languageNode?: SyntaxNode) {
  if (!languageNode) return "";
  return normalizeFenceLanguage(state.sliceDoc(languageNode.from, languageNode.to));
}

function normalizeFenceLanguage(language: string) {
  let token = firstToken(language.trim());
  if (token.startsWith("{")) token = token.slice(1);
  if (token.startsWith(".")) token = token.slice(1);
  if (token.endsWith("}")) token = token.slice(0, -1);
  return token.toLowerCase();
}

function readMermaidDiagram(
  state: EditorState,
  content: SyntaxNode,
  language: string,
): MermaidDiagram | null {
  if (!isMermaidFenceLanguage(language)) return null;
  let source = state.sliceDoc(content.from, content.to).replace(/\s+$/u, "");
  return source.trim() ? { source } : null;
}

function isMermaidFenceLanguage(language: string) {
  return language == "mermaid" || language == "mmd";
}

function firstToken(value: string) {
  for (let index = 0; index < value.length; index++) {
    if (isWhitespace(value.charCodeAt(index))) return value.slice(0, index);
  }
  return value;
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

function tableTouchesActiveLine(
  context: LiveMdFeatureContext,
  from: number,
  to: number,
  table: MarkdownTable,
) {
  if (context.touchesActiveLine(from, to)) return true;
  if (table.rows.length) return false;
  let end = Math.min(to, context.state.doc.length);
  let lastLine = context.state.doc.lineAt(Math.max(from, end - 1));
  let nextLineNumber = lastLine.number + 1;
  if (!context.activeLines.has(nextLineNumber) || nextLineNumber > context.state.doc.lines) {
    return false;
  }
  let nextLine = context.state.doc.line(nextLineNumber);
  return isWhitespaceOnly(context.state.sliceDoc(nextLine.from, nextLine.to));
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

function normalizeTableCells(cells: string[], columnCount: number) {
  let normalized = cells.slice(0, columnCount);
  while (normalized.length < columnCount) normalized.push("");
  return normalized;
}

function normalizeTableAlignments(
  alignments: Array<"center" | "default" | "left" | "right">,
  columnCount: number,
) {
  let normalized = alignments.slice(0, columnCount);
  while (normalized.length < columnCount) normalized.push("default");
  return normalized;
}

const paragraphBreakFeature: LiveMdFeature<Map<string, ParagraphContainer>> = {
  id: "paragraphBreak",
  priority: 10,
  query: {
    document: `
((document (section) @paragraph.child) @paragraph.container
  (#set! paragraph.kind "document"))

((section [
  (atx_heading)
  (block_quote)
  (fenced_code_block)
  (list)
  (paragraph)
  (pipe_table)
  (setext_heading)
  (thematic_break)
] @paragraph.child) @paragraph.container
  (#set! paragraph.kind "block"))

((block_quote [
  (block_quote)
  (fenced_code_block)
  (list)
  (paragraph)
  (pipe_table)
  (setext_heading)
  (thematic_break)
] @paragraph.child) @paragraph.container
  (#set! paragraph.kind "block"))

((list (list_item) @paragraph.child) @paragraph.container
  (#set! paragraph.kind "list"))

((list_item [
  (block_quote)
  (fenced_code_block)
  (list)
  (paragraph)
  (pipe_table)
  (setext_heading)
  (thematic_break)
] @paragraph.child) @paragraph.container
  (#set! paragraph.kind "listItem"))
`,
  },
  create: () => new Map(),
  collect: (match, containers) => collectParagraphContainer(match, containers),
  finish: (containers, context) => markParagraphBreaks(context, containers),
};

const headingFeature: LiveMdFeature = {
  id: "heading",
  priority: 20,
  query: {
    document: `
((atx_heading . (atx_h1_marker) @heading.marker) @heading
  (#set! heading.level "1"))
((atx_heading . (atx_h2_marker) @heading.marker) @heading
  (#set! heading.level "2"))
((atx_heading . (atx_h3_marker) @heading.marker) @heading
  (#set! heading.level "3"))
((atx_heading . (atx_h4_marker) @heading.marker) @heading
  (#set! heading.level "4"))
((atx_heading . (atx_h5_marker) @heading.marker) @heading
  (#set! heading.level "5"))
((atx_heading . (atx_h6_marker) @heading.marker) @heading
  (#set! heading.level "6"))
((setext_heading heading_content: (paragraph) (setext_h1_underline) @heading.marker) @heading
  (#set! heading.level "1"))
((setext_heading heading_content: (paragraph) (setext_h2_underline) @heading.marker) @heading
  (#set! heading.level "2"))
`,
  },
  apply: (match, _state, context) => applyHeadingMatch(context, match),
};

const syntaxFeature: LiveMdFeature = {
  id: "syntax",
  priority: 30,
  query: {
    document: `
(block_continuation) @syntax
(block_quote_marker) @syntax
`,
    inline: `
(code_span_delimiter) @syntax
(emphasis_delimiter) @syntax
`,
  },
  apply(match, _state, context) {
    for (let item of captures(match, "syntax")) {
      let key = `syntax:${nodeKey(item.node)}`;
      if (context.claim(key)) context.syntax(item.node.from, item.node.to);
    }
  },
};

const blockquoteFeature: LiveMdFeature = {
  id: "blockquote",
  priority: 40,
  query: {
    document: `(block_quote) @blockquote`,
  },
  apply(match, _state, context) {
    for (let item of captures(match, "blockquote")) {
      context.lineClass(item.node.from, item.node.to, "cm-md-blockquote");
    }
  },
};

const listFeature: LiveMdFeature = {
  id: "list",
  priority: 50,
  query: {
    document: `
(list_item) @list.item
(list_marker_dot) @list.marker
(list_marker_minus) @list.marker
(list_marker_parenthesis) @list.marker
(list_marker_plus) @list.marker
(list_marker_star) @list.marker
`,
  },
  apply(match, _state, context) {
    for (let item of captures(match, "list.item")) {
      context.lineClass(item.node.from, item.node.to, "cm-md-list-line");
    }
    for (let item of captures(match, "list.marker")) {
      let key = `list.marker:${nodeKey(item.node)}`;
      if (context.claim(key)) applyListMarker(context, item.node);
    }
  },
};

const taskFeature: LiveMdFeature = {
  id: "task",
  priority: 60,
  query: {
    document: `
(task_list_marker_checked) @task.checked
(task_list_marker_unchecked) @task.unchecked
`,
  },
  apply(match, _state, context) {
    for (let item of captures(match, "task.checked")) applyTaskMarker(context, item.node, true);
    for (let item of captures(match, "task.unchecked")) applyTaskMarker(context, item.node, false);
  },
};

const ruleFeature: LiveMdFeature = {
  id: "rule",
  priority: 70,
  query: {
    document: `(thematic_break) @rule`,
  },
  apply(match, _state, context) {
    let node = capture(match, "rule")?.node;
    if (node) applyRule(context, node);
  },
};

const codeFenceFeature: LiveMdFeature = {
  id: "codeFence",
  priority: 80,
  query: {
    document: `
((fenced_code_block
  .
  (fenced_code_block_delimiter) @codeFence.open
  (info_string (language) @codeFence.language)?
  (block_continuation)?
  (code_fence_content)? @codeFence.content
  (fenced_code_block_delimiter)? @codeFence.close
  .) @codeFence)
`,
  },
  apply: (match, _state, context) => applyCodeFence(context, match),
};

const tableFeature: LiveMdFeature<Map<string, CapturedTable>> = {
  id: "table",
  priority: 90,
  query: {
    document: `
(pipe_table) @table
((pipe_table (pipe_table_header (pipe_table_cell) @table.header.cell) @table.header) @table)
((pipe_table (pipe_table_delimiter_row) @table.delimiter.row) @table)
((pipe_table
  (pipe_table_delimiter_row
    (pipe_table_delimiter_cell
      (pipe_table_align_left)? @table.align.left
      (pipe_table_align_right)? @table.align.right) @table.delimiter.cell)) @table)
((pipe_table (pipe_table_row (pipe_table_cell) @table.row.cell) @table.row) @table)
((pipe_table (pipe_table_header "|" @table.pipe)) @table)
((pipe_table (pipe_table_delimiter_row "|" @table.pipe)) @table)
((pipe_table (pipe_table_row "|" @table.pipe)) @table)
`,
  },
  create: () => new Map(),
  collect: (match, tables) => collectTable(match, tables),
  apply: (match, tables, context) => applyTable(context, match, tables),
};

const inlineMarkFeature: LiveMdFeature = {
  id: "inlineMark",
  priority: 100,
  query: {
    inline: `
(code_span) @mark.inlineCode
(emphasis) @mark.emphasis
(strikethrough) @mark.strike
(strong_emphasis) @mark.strong
`,
  },
  apply(match, _state, context) {
    for (let item of captures(match, "mark.inlineCode")) {
      context.mark(item.node.from, item.node.to, inlineCodeMark);
    }
    for (let item of captures(match, "mark.emphasis")) {
      context.mark(item.node.from, item.node.to, emphasisMark);
    }
    for (let item of captures(match, "mark.strike")) {
      context.mark(item.node.from, item.node.to, strikeMark);
    }
    for (let item of captures(match, "mark.strong")) {
      context.mark(item.node.from, item.node.to, strongMark);
    }
  },
};

const autolinkFeature: LiveMdFeature = {
  id: "autolink",
  priority: 110,
  query: {
    inline: `(uri_autolink) @uriAutolink`,
  },
  apply(match, _state, context) {
    for (let item of captures(match, "uriAutolink")) applyUriAutolink(context, item.node);
  },
};

const linkFeature: LiveMdFeature = {
  id: "link",
  priority: 120,
  query: {
    inline: `
((inline_link
  .
  (link_text) @link.text
  (link_destination)? @link.destination
  (link_title)?
  .) @link)
`,
  },
  apply: (match, _state, context) => applyInlineLink(context, match),
};

const imageFeature: LiveMdFeature = {
  id: "image",
  priority: 130,
  query: {
    inline: `
((image
  .
  (image_description)? @image.description
  (link_destination)? @image.destination
  (link_title)?
  .) @image)
`,
  },
  apply: (match, _state, context) => applyImage(context, match),
};

const latexFeature: LiveMdFeature = {
  id: "latex",
  priority: 140,
  query: {
    inline: `
((latex_block
  .
  (latex_span_delimiter) @latex.open
  (latex_span_delimiter) @latex.close
  .) @latex
  (#set! injection.language "latex"))
`,
  },
  apply: (match, _state, context) => applyLatex(context, match),
};

const defaultLiveMdFeatures: readonly LiveMdFeature<unknown>[] = [
  eraseLiveMdFeatureState(paragraphBreakFeature),
  eraseLiveMdFeatureState(headingFeature),
  eraseLiveMdFeatureState(syntaxFeature),
  eraseLiveMdFeatureState(blockquoteFeature),
  eraseLiveMdFeatureState(listFeature),
  eraseLiveMdFeatureState(taskFeature),
  eraseLiveMdFeatureState(ruleFeature),
  eraseLiveMdFeatureState(codeFenceFeature),
  eraseLiveMdFeatureState(tableFeature),
  eraseLiveMdFeatureState(inlineMarkFeature),
  eraseLiveMdFeatureState(autolinkFeature),
  eraseLiveMdFeatureState(linkFeature),
  eraseLiveMdFeatureState(imageFeature),
  eraseLiveMdFeatureState(latexFeature),
];

export const liveMdAnalysis: Extension = [
  liveMdFeatures(defaultLiveMdFeatures),
  liveMdAnalysisField,
  liveMdViewportPlugin,
];

function eraseLiveMdFeatureState<State>(feature: LiveMdFeature<State>) {
  return feature as unknown as LiveMdFeature<unknown>;
}
