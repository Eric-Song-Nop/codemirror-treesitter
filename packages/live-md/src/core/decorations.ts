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
  highlightTree,
  queryTreeMatches,
  syntaxTree,
  type SyntaxNode,
  type Tree,
  type TreeSitterParser,
  type TreeSitterQueryCapture,
  type TreeSitterQueryMatch,
} from "@codemirror-treesitter/language";
import { gruvboxLightHighlightStyle } from "@codemirror-treesitter/theme-gruvbox";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  codeFenceLanguagesField,
  emptyCodeFenceLanguages,
  type CodeFenceLanguageMap,
} from "./languages.js";
import { forEachLineInRange, isWhitespace, isWhitespaceOnly, splitRangeByLine } from "./util.js";
import { liveMdLinkBaseUrl, liveMdLinkMark } from "./links.js";
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
import liveMdMarkdownInlineQuerySource from "./queries/decorations-markdown-inline.scm?raw";
import liveMdMarkdownQuerySource from "./queries/decorations-markdown.scm?raw";

type LiveMdBuild = {
  activeLines: Set<number>;
  atomicRanges: Array<{ from: number; to: number }>;
  codeFenceHighlightTrees: CodeFenceHighlightTree[];
  codeFenceLanguages: CodeFenceLanguageMap;
  decorations: Array<Range<Decoration>>;
  lineClasses: Map<number, Set<string>>;
  linkBaseUrl: string | null;
  state: EditorState;
};

type DocRange = {
  from: number;
  to: number;
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
      !codeFenceLanguagesChanged(transaction.startState, transaction.state) &&
      transaction.startState.facet(liveMdLinkBaseUrl) == transaction.state.facet(liveMdLinkBaseUrl)
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

export const liveMdAnalysis: Extension = [liveMdAnalysisField, liveMdViewportPlugin];

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
    codeFenceLanguages,
    decorations: [],
    lineClasses: new Map(),
    linkBaseUrl: state.facet(liveMdLinkBaseUrl),
    state,
  };
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

  let tree = syntaxTree(state);
  let skipped: Array<{ from: number; to: number }> = [];
  let matches = queryLiveMdMatches(tree, ranges);
  let paragraphContainers = new Map<string, ParagraphContainer>();
  let tables = new Map<string, CapturedTable>();
  for (let match of matches) {
    collectParagraphContainer(match, paragraphContainers);
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
  markParagraphBreaks(build, paragraphContainers);

  return build;
}

function queryLiveMdMatches(tree: Tree, ranges: readonly DocRange[]) {
  let matches: TreeSitterQueryMatch[] = [];
  for (let { from, to } of ranges) {
    let options = from <= 0 && to >= tree.length ? undefined : { from, to };
    matches.push(...queryTreeMatches(tree, liveMdQuerySource, options));
  }
  return matches;
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

function liveMdQuerySource(_parser: TreeSitterParser, tree: Tree) {
  if (tree.topNode.name == "document") return liveMdMarkdownQuerySource;
  if (tree.topNode.name == "inline") return liveMdMarkdownInlineQuerySource;
  return null;
}

function isInsideSkippedRange(node: SyntaxNode, ranges: readonly { from: number; to: number }[]) {
  return ranges.some((range) => node.from >= range.from && node.to <= range.to);
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

type LiveMdMatchKind = "codeFence" | "heading" | "image" | "latex" | "link" | "rule" | "table";

type SimpleCaptureHandler = (build: LiveMdBuild, node: SyntaxNode) => void;

const simpleCaptureHandlers: Record<string, SimpleCaptureHandler> = {
  blockquote: (build, node) => addLineRangeClass(build, node.from, node.to, "cm-md-blockquote"),
  "list.item": (build, node) => addLineRangeClass(build, node.from, node.to, "cm-md-list-line"),
  "list.marker": applyListMarker,
  "mark.emphasis": (build, node) => addMark(build, node.from, node.to, emphasisMark),
  "mark.inlineCode": (build, node) => addMark(build, node.from, node.to, inlineCodeMark),
  "mark.strike": (build, node) => addMark(build, node.from, node.to, strikeMark),
  "mark.strong": (build, node) => addMark(build, node.from, node.to, strongMark),
  syntax: (build, node) => addSyntax(build, node.from, node.to),
  "task.checked": (build, node) => applyTaskMarker(build, node, true),
  "task.unchecked": (build, node) => applyTaskMarker(build, node, false),
  uriAutolink: applyUriAutolink,
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
  build: LiveMdBuild,
  containers: ReadonlyMap<string, ParagraphContainer>,
) {
  for (let container of containers.values()) {
    if (container.kind == "listItem") continue;
    let siblings = sortedNodes(container.children);
    let previousFrom =
      container.kind == "list"
        ? (node: SyntaxNode) => blockContainerBreakFrom(build, node, containers)
        : (node: SyntaxNode) => blockBreakFrom(build, node);
    for (let index = 1; index < siblings.length; index++) {
      markParagraphBreakRun(build, previousFrom(siblings[index - 1]!), siblings[index]!.from);
    }
    let last = siblings.at(-1);
    if (last) markParagraphBreakRun(build, previousFrom(last), container.node.to);
  }
}

function blockBreakFrom(build: LiveMdBuild, node: SyntaxNode): number {
  if (node.to <= node.from) return node.to;
  let before = node.to - 1;
  if (build.state.sliceDoc(before, node.to) != "\n") return node.to;
  return build.state.doc.lineAt(before).to;
}

function blockContainerBreakFrom(
  build: LiveMdBuild,
  node: SyntaxNode,
  containers: ReadonlyMap<string, ParagraphContainer>,
) {
  let blocks = sortedNodes(containers.get(nodeKey(node))?.children);
  return blocks.length ? blockBreakFrom(build, blocks[blocks.length - 1]!) : node.to;
}

function codeFenceLanguagesChanged(startState: EditorState, state: EditorState) {
  return (
    startState.field(codeFenceLanguagesField, false) != state.field(codeFenceLanguagesField, false)
  );
}

function getActiveLines(state: EditorState) {
  let lines = new Set<number>();
  for (let range of state.selection.ranges) {
    lines.add(state.doc.lineAt(range.head).number);
  }
  return lines;
}

function matchRoot(match: TreeSitterQueryMatch): SyntaxNode | null {
  return capture(match, "feature")?.node ?? match.captures[0]?.node ?? null;
}

function matchKind(match: TreeSitterQueryMatch): LiveMdMatchKind | null {
  let kind = match.setProperties?.["liveMd.kind"];
  if (typeof kind != "string" || !isLiveMdMatchKind(kind)) return null;
  return kind;
}

function isLiveMdMatchKind(kind: string): kind is LiveMdMatchKind {
  switch (kind) {
    case "codeFence":
    case "heading":
    case "image":
    case "latex":
    case "link":
    case "rule":
    case "table":
      return true;
    default:
      return false;
  }
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

function captureKey(capture: TreeSitterQueryCapture) {
  return `${capture.name}:${nodeKey(capture.node)}`;
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

function markParagraphBreakRun(build: LiveMdBuild, from: number, to: number) {
  if (from >= to || !isWhitespaceOnly(build.state.sliceDoc(from, to))) return;

  let newlinePositions: number[] = [];
  let source = build.state.sliceDoc(from, to);
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) == 10) newlinePositions.push(from + index);
  }

  let separatorCount = Math.floor(newlinePositions.length / 2);
  if (!separatorCount) return;

  let blankLines: number[] = [];
  forEachLineInRange(build.state, from, to, (line) => {
    if (line.from > from && isWhitespaceOnly(build.state.sliceDoc(line.from, line.to))) {
      blankLines.push(line.number);
    }
  });

  for (let index = 0; index < separatorCount; index++) {
    addAtom(build, newlinePositions[index * 2], newlinePositions[index * 2 + 1] + 1);

    let separatorLine = blankLines[index * 2];
    if (separatorLine == null) return;
    addLineClass(build, separatorLine, "cm-md-block-separator");
  }
}

function processLiveMdMatch(
  build: LiveMdBuild,
  match: TreeSitterQueryMatch,
  tables: ReadonlyMap<string, CapturedTable>,
  processed: Set<string>,
  skipped: readonly { from: number; to: number }[],
): false | void {
  switch (matchKind(match)) {
    case "codeFence":
      return applyCodeFence(build, match);
    case "heading":
      return applyHeadingMatch(build, match);
    case "image":
      return applyImage(build, match);
    case "latex":
      return applyLatex(build, match);
    case "link":
      return applyInlineLink(build, match);
    case "rule": {
      let node = capture(match, "rule")?.node;
      if (node) return applyRule(build, node);
      return;
    }
    case "table":
      return applyTable(build, match, tables, processed);
  }

  for (let item of match.captures) {
    if (isInsideSkippedRange(item.node, skipped)) continue;
    let handler = simpleCaptureHandlers[item.name];
    if (!handler) continue;
    let key = captureKey(item);
    if (processed.has(key)) continue;
    processed.add(key);
    handler(build, item.node);
  }
}

function applyHeadingMatch(build: LiveMdBuild, match: TreeSitterQueryMatch) {
  let node = capture(match, "heading")?.node;
  if (!node) return;
  let level = Number(match.setProperties?.["heading.level"]) || 1;
  applyHeading(build, node, level, capture(match, "heading.marker")?.node);
}

function applyHeading(build: LiveMdBuild, node: SyntaxNode, level: number, marker?: SyntaxNode) {
  addLineRangeClass(build, node.from, node.to, "cm-md-heading");
  addLineRangeClass(build, node.from, node.to, `cm-md-heading-${level}`);
  if (marker) addSyntax(build, marker.from, marker.to);
}

function applyListMarker(build: LiveMdBuild, node: SyntaxNode) {
  let line = build.state.doc.lineAt(node.from);
  addLineClass(build, line.number, "cm-md-list-line");
  if (build.activeLines.has(line.number)) {
    addSyntax(build, node.from, node.to);
  } else {
    addReplace(
      build,
      node.from,
      node.to,
      new ListMarkerWidget(build.state.sliceDoc(node.from, node.to).trim()),
    );
  }
}

function applyTaskMarker(build: LiveMdBuild, node: SyntaxNode, checked: boolean) {
  let line = build.state.doc.lineAt(node.from);
  addLineClass(build, line.number, "cm-md-list-line");
  addLineClass(build, line.number, "cm-md-task-line");
  if (checked) addLineClass(build, line.number, "is-checked");
  addReplace(build, node.from, node.to, new TaskCheckboxWidget(checked));
}

function applyRule(build: LiveMdBuild, node: SyntaxNode): false {
  addLineRangeClass(build, node.from, node.to, "cm-md-rule-line");
  addSyntax(build, node.from, node.to);
  return false;
}

function applyInlineLink(build: LiveMdBuild, match: TreeSitterQueryMatch) {
  let node = capture(match, "link")?.node;
  let text = capture(match, "link.text")?.node;
  let destination = capture(match, "link.destination")?.node;
  if (!node) return;
  if (!text) return;
  addSyntax(build, node.from, text.from);
  addMark(
    build,
    text.from,
    text.to,
    liveMdLinkMark(
      destination ? build.state.sliceDoc(destination.from, destination.to) : null,
      build.linkBaseUrl,
    ),
  );
  addSyntax(build, text.to, node.to);
}

function applyUriAutolink(build: LiveMdBuild, node: SyntaxNode) {
  if (node.to - node.from <= 2) return;
  addSyntax(build, node.from, node.from + 1);
  addMark(
    build,
    node.from + 1,
    node.to - 1,
    liveMdLinkMark(build.state.sliceDoc(node.from + 1, node.to - 1), build.linkBaseUrl),
  );
  addSyntax(build, node.to - 1, node.to);
}

function applyImage(build: LiveMdBuild, match: TreeSitterQueryMatch): false | void {
  let node = capture(match, "image")?.node;
  if (!node) return false;
  let description = capture(match, "image.description")?.node;
  let destination = capture(match, "image.destination")?.node;
  let alt = description ? build.state.sliceDoc(description.from, description.to) : "";
  let src = destination ? build.state.sliceDoc(destination.from, destination.to).trim() : "";
  if (!src) return false;

  let line = build.state.doc.lineAt(node.from);
  let active = build.activeLines.has(line.number);
  let widget = new ImagePreviewWidget(alt, normalizeImageSource(src));
  if (!active && isOnlyVisibleContentOnLine(build.state, line.from, line.to, node.from, node.to)) {
    addReplace(build, line.from, line.to, widget, true);
    return false;
  }

  if (!active) {
    addReplace(build, node.from, node.to, widget);
    return false;
  }

  if (description) {
    addSyntax(build, node.from, description.from);
    addMark(build, description.from, description.to, liveMdLinkMark(null, build.linkBaseUrl));
    addSyntax(build, description.to, node.to);
  }
  return false;
}

function applyLatex(build: LiveMdBuild, match: TreeSitterQueryMatch): false | void {
  let node = capture(match, "latex")?.node;
  let openingDelimiter = capture(match, "latex.open")?.node;
  let closingDelimiter = capture(match, "latex.close")?.node;
  if (!node || !openingDelimiter || !closingDelimiter) return false;
  let formula = readLatexFormula(build.state, node, openingDelimiter, closingDelimiter);
  if (!formula) return false;
  if (rangeTouchesActiveLine(build, node.from, node.to)) return;

  let range = latexReplacementRange(build.state, node, formula.displayMode);
  addReplace(
    build,
    range.from,
    range.to,
    new LatexWidget({ ...formula, block: range.block }),
    range.block,
  );
  return false;
}

function applyTable(
  build: LiveMdBuild,
  match: TreeSitterQueryMatch,
  tables: ReadonlyMap<string, CapturedTable>,
  processed: Set<string>,
): false | void {
  let tableCapture = capture(match, "table");
  if (!tableCapture) return;
  let node = tableCapture.node;
  let key = `table:${nodeKey(node)}`;
  if (processed.has(key)) return;
  processed.add(key);

  let captured = tables.get(nodeKey(node));
  let table = captured ? readTableFromCaptures(build.state, captured) : null;
  if (table && !tableTouchesActiveLine(build, node.from, node.to, table)) {
    addReplace(build, node.from, node.to, new TablePreviewWidget(table), true);
    return false;
  }

  addLineRangeClass(build, node.from, node.to, "cm-md-table-line");
  if (captured?.delimiterRow) {
    addLineRangeClass(
      build,
      captured.delimiterRow.from,
      captured.delimiterRow.to,
      "cm-md-table-divider",
    );
  }
  for (let pipe of sortedNodes(captured?.pipes.values())) {
    addSyntax(build, pipe.from, pipe.to, tablePipeMark);
  }
  return false;
}

function applyCodeFence(build: LiveMdBuild, match: TreeSitterQueryMatch): false {
  let node = capture(match, "codeFence")?.node;
  let openingDelimiter = capture(match, "codeFence.open")?.node;
  if (!node || !openingDelimiter) return false;

  let closingDelimiter = capture(match, "codeFence.close")?.node ?? null;
  let content = capture(match, "codeFence.content")?.node;
  let language = readFenceLanguage(build.state, capture(match, "codeFence.language")?.node);

  if (content && content.from < content.to) {
    let diagram = readMermaidDiagram(build.state, content, language);
    if (diagram && !rangeTouchesActiveLine(build, node.from, node.to)) {
      addReplace(build, node.from, node.to, new MermaidWidget(diagram), true);
      return false;
    }
  }

  let openingLineNumber = build.state.doc.lineAt(openingDelimiter.from).number;
  let blockEndLineNumber = openingLineNumber;

  addLineClass(build, openingLineNumber, "cm-md-code-fence-line");
  addLineClass(build, openingLineNumber, "cm-md-code-block-start");
  addSyntax(build, openingDelimiter.from, openingDelimiter.to);

  if (content && content.from < content.to) {
    forEachLineInRange(build.state, content.from, content.to, (line) => {
      addLineClass(build, line.number, "cm-md-code-line");
      blockEndLineNumber = line.number;
    });
    addCodeFenceHighlights(build, content.from, content.to, language);
  }

  if (closingDelimiter) {
    let closingLineNumber = build.state.doc.lineAt(closingDelimiter.from).number;
    blockEndLineNumber = closingLineNumber;
    addLineClass(build, closingLineNumber, "cm-md-code-fence-line");
    addSyntax(build, closingDelimiter.from, closingDelimiter.to);
  }

  addLineClass(build, blockEndLineNumber, "cm-md-code-block-end");
  return false;
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
    gruvboxLightHighlightStyle,
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
  build: LiveMdBuild,
  from: number,
  to: number,
  table: MarkdownTable,
) {
  if (rangeTouchesActiveLine(build, from, to)) return true;
  if (table.rows.length) return false;
  let end = Math.min(to, build.state.doc.length);
  let lastLine = build.state.doc.lineAt(Math.max(from, end - 1));
  let nextLineNumber = lastLine.number + 1;
  if (!build.activeLines.has(nextLineNumber) || nextLineNumber > build.state.doc.lines) {
    return false;
  }
  let nextLine = build.state.doc.line(nextLineNumber);
  return isWhitespaceOnly(build.state.sliceDoc(nextLine.from, nextLine.to));
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

function normalizeImageSource(source: string) {
  return source.trim();
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
