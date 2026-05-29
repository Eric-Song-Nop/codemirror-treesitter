import {
  type ChangeDesc,
  ChangeSet,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  StateField,
  Text,
} from "@codemirror/state";
import {
  highlightTree,
  patchRangeSet,
  rangesTouch,
  syntaxTree,
  syntaxTreeChangedRanges,
  type SyntaxNode,
  type Tree,
} from "@codemirror-treesitter/language";
import { gruvboxLightHighlightStyle } from "@codemirror-treesitter/theme-gruvbox";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import {
  codeFenceLanguagesField,
  emptyCodeFenceLanguages,
  type CodeFenceLanguageMap,
} from "./languages.js";
import {
  analyzeLiveMdDirtyRanges,
  type LiveMdDirtyRange,
  type LiveMdDirtyReason,
  type LiveMdDirtySourceRange,
} from "./dirty-ranges.js";
import { createLiveMdFeatureRegistry, type LiveMdFeature, type LiveMdScope } from "./features.js";
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

type InlineDecoration = {
  from: number;
  to: number;
  decoration: Decoration;
};

type VisitContext = {
  activeLines: Set<number>;
  codeFenceHighlightCache: Map<string, CodeFenceHighlightTree>;
  codeFenceLanguages: CodeFenceLanguageMap;
  dirtyRange: LiveMdDirtyRange | null;
  dirtyReasons: readonly LiveMdDirtyReason[] | null;
  linkBaseUrl: string | null;
  plannedCodeFenceHighlightKeys: Set<string>;
  previousCodeFenceHighlights: readonly CodeFenceHighlightTree[];
  changes: ChangeDesc | null;
  plan: DecorationPlan;
  state: EditorState;
};

type NodeVisitor = (context: VisitContext, node: SyntaxNode) => false | void;
type LiveMdNodeFeature = LiveMdFeature<VisitContext, SyntaxNode>;

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

type CodeFenceSyntaxChanges = {
  highlights: readonly CodeFenceHighlightTree[];
  sourceRanges: readonly LiveMdDirtySourceRange[];
};

type CodeFenceContentChangeResult = {
  changes: ChangeSet;
  touched: boolean;
};

const emptyCodeFenceSyntaxChanges: CodeFenceSyntaxChanges = {
  highlights: [],
  sourceRanges: [],
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
  dirtyRanges: readonly LiveMdDirtyRange[];
  expandedDirtyRanges: readonly LiveMdDirtyRange[];
};

export const liveMdAnalysis = StateField.define<LiveMdAnalysis>({
  create(state) {
    return buildLiveMdAnalysis(state, [], []);
  },
  update(value, transaction) {
    let codeFenceLanguageUpdate = codeFenceLanguagesChanged(
      transaction.startState,
      transaction.state,
    );
    let syntaxChangedRanges = syntaxTreeChangedRanges(transaction);
    if (
      !transaction.docChanged &&
      !transaction.selection &&
      !codeFenceLanguageUpdate &&
      !syntaxChangedRanges.length
    ) {
      return value;
    }
    let codeFenceSyntaxChanges =
      transaction.docChanged && !codeFenceLanguageUpdate
        ? analyzeCodeFenceSyntaxChanges(
            transaction.state,
            transaction.changes,
            value.codeFenceHighlightTrees,
          )
        : emptyCodeFenceSyntaxChanges;
    let activeLines = getActiveLines(transaction.state);
    let { dirtyRanges, expandedDirtyRanges } = analyzeLiveMdDirtyRanges({
      activeLines: transaction.selection ? Array.from(activeLines) : undefined,
      changes: transaction.changes,
      invalidations: codeFenceLanguageUpdate
        ? [
            {
              nodes: liveMdFeatureRegistry.invalidatedNodes("codeFenceLanguages"),
              reason: "codeFenceLanguages",
            },
          ]
        : undefined,
      previousActiveLines: transaction.selection ? Array.from(value.activeLines) : undefined,
      registry: liveMdFeatureRegistry,
      sourceRanges: codeFenceSyntaxChanges.sourceRanges,
      startState: transaction.startState,
      state: transaction.state,
      syntaxChangedRanges,
    });
    return patchLiveMdAnalysis(
      value,
      transaction.state,
      transaction.changes,
      dirtyRanges,
      expandedDirtyRanges,
      activeLines,
      codeFenceSyntaxChanges.highlights,
    );
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

const liveMdFeatures: readonly LiveMdNodeFeature[] = [
  feature(["atx_heading"], visitHeading, "line"),
  feature(["block_continuation"], visitSyntax, "line"),
  feature(["block_quote"], visitBlockQuote, "container"),
  feature(["block_quote_marker"], visitSyntax, "line"),
  feature(["code_span"], visitMark(inlineCodeMark)),
  feature(["code_span_delimiter"], visitSyntax),
  feature(["code_fence_content"], undefined, "line", ["codeFenceLanguages"]),
  feature(["document"], visitDocument, "document"),
  feature(["emphasis"], visitMark(emphasisMark)),
  feature(["emphasis_delimiter"], visitSyntax),
  feature(["fenced_code_block"], visitCodeFence, "node"),
  feature(
    [
      "html_block",
      "indented_code_block",
      "link_reference_definition",
      "minus_metadata",
      "plus_metadata",
    ],
    undefined,
    "line",
  ),
  feature(["image"], visitImage, "line"),
  feature(["inline_link"], visitInlineLink),
  feature(["latex_block"], visitLatex, "node"),
  feature(["latex_span_delimiter"], visitSyntax),
  feature(["list"], visitList, "container"),
  feature(["list_item"], visitLineClass("cm-md-list-line"), "block"),
  feature(
    [
      "list_marker_dot",
      "list_marker_minus",
      "list_marker_parenthesis",
      "list_marker_plus",
      "list_marker_star",
    ],
    visitListMarker,
    "line",
  ),
  feature(["pipe_table"], visitTable, "node"),
  feature(["paragraph"], undefined, "line"),
  feature(["section"], visitSection, "container"),
  feature(["setext_heading"], visitSetextHeading, "block"),
  feature(["strikethrough"], visitMark(strikeMark)),
  feature(["strong_emphasis"], visitMark(strongMark)),
  feature(["task_list_marker_checked", "task_list_marker_unchecked"], visitTaskMarker, "line"),
  feature(["thematic_break"], visitRule, "line"),
  feature(["uri_autolink"], visitUriAutolink),
];

const liveMdFeatureRegistry = createLiveMdFeatureRegistry(liveMdFeatures);
export const __testLiveMdFeatureRegistry = liveMdFeatureRegistry;

class AtomicRange extends RangeValue {
  eq(other: RangeValue) {
    return other instanceof AtomicRange;
  }
}

const paragraphBreakAtom = new AtomicRange();

class DecorationPlan {
  private atomicRanges: Array<{ from: number; to: number }> = [];
  private codeFenceHighlightTrees: CodeFenceHighlightTree[] = [];
  private dirtyRange: LiveMdDirtyRange | null = null;
  private lineClasses = new Map<number, Set<string>>();
  private ranges: InlineDecoration[] = [];
  private state: EditorState;

  constructor(state: EditorState) {
    this.state = state;
  }

  setDirtyRange(range: LiveMdDirtyRange | null) {
    this.dirtyRange = range;
  }

  line(lineNumber: number, className: string) {
    let line = this.state.doc.line(lineNumber);
    if (!this.touchesDirtyRange(line.from, line.to)) return;

    let classes = this.lineClasses.get(lineNumber);
    if (!classes) this.lineClasses.set(lineNumber, (classes = new Set()));
    classes.add(className);
  }

  lineClass(from: number, to: number, className: string) {
    forEachLineInRange(this.state, from, to, (line) => this.line(line.number, className));
  }

  atom(from: number, to: number) {
    if (from < to && this.touchesDirtyRange(from, to)) this.atomicRanges.push({ from, to });
  }

  codeFenceHighlight(tree: CodeFenceHighlightTree) {
    this.codeFenceHighlightTrees.push(tree);
  }

  mark(from: number, to: number, decoration: Decoration) {
    if (from < to && this.touchesDirtyRange(from, to)) {
      this.ranges.push({ from, to, decoration });
    }
  }

  markByLine(from: number, to: number, decorationForLine: (lineNumber: number) => Decoration) {
    splitRangeByLine(this.state, from, to, (lineNumber, rangeFrom, rangeTo) => {
      this.mark(rangeFrom, rangeTo, decorationForLine(lineNumber));
    });
  }

  replace(from: number, to: number, widget: WidgetType, block = false) {
    this.mark(from, to, Decoration.replace({ block, widget }));
  }

  syntax(from: number, to: number, activeLines: Set<number>, decoration?: Decoration) {
    this.markByLine(from, to, (lineNumber) => {
      if (decoration) return decoration;
      return activeLines.has(lineNumber) ? visibleSyntax : hiddenSyntax;
    });
  }

  finish() {
    let builder = new RangeSetBuilder<Decoration>();
    for (let range of this.finishDecorationRanges()) {
      builder.add(range.from, range.to, range.value);
    }
    return builder.finish();
  }

  finishDecorationRanges() {
    let decorations = this.finishDecorationSpecs();
    return decorations.map(({ from, to, decoration }) => decoration.range(from, to));
  }

  finishAtomicRanges() {
    let builder = new RangeSetBuilder<RangeValue>();
    for (let range of this.finishAtomicRangeValues()) {
      builder.add(range.from, range.to, range.value);
    }
    return builder.finish();
  }

  finishAtomicRangeValues() {
    this.atomicRanges.sort((left, right) => left.from - right.from || left.to - right.to);
    return this.atomicRanges.map(({ from, to }) => paragraphBreakAtom.range(from, to));
  }

  finishCodeFenceHighlightTrees() {
    return this.codeFenceHighlightTrees;
  }

  private finishDecorationSpecs() {
    let decorations = [...this.ranges];
    for (let [lineNumber, classes] of this.lineClasses) {
      let line = this.state.doc.line(lineNumber);
      decorations.push({
        from: line.from,
        to: line.from,
        decoration: Decoration.line({ class: [...classes].join(" ") }),
      });
    }

    decorations.sort((left, right) => left.from - right.from || left.to - right.to);
    return decorations;
  }

  private touchesDirtyRange(from: number, to: number) {
    return !this.dirtyRange || rangesTouch(from, to, this.dirtyRange.from, this.dirtyRange.to);
  }
}

function buildLiveMdAnalysis(
  state: EditorState,
  dirtyRanges: readonly LiveMdDirtyRange[],
  expandedDirtyRanges: readonly LiveMdDirtyRange[],
  activeLines = getActiveLines(state),
): LiveMdAnalysis {
  let codeFenceLanguages = state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages;
  let plan = buildLiveMdPlan(state, activeLines, codeFenceLanguages);
  return {
    activeLines,
    atomicRanges: plan.finishAtomicRanges(),
    codeFenceHighlightTrees: plan.finishCodeFenceHighlightTrees(),
    codeFenceLanguages,
    decorations: plan.finish(),
    dirtyRanges,
    expandedDirtyRanges,
  };
}

export function __testBuildLiveMdAnalysis(state: EditorState) {
  return buildLiveMdAnalysis(state, [], []);
}

function patchLiveMdAnalysis(
  previous: LiveMdAnalysis,
  state: EditorState,
  changes: ChangeDesc,
  dirtyRanges: readonly LiveMdDirtyRange[],
  expandedDirtyRanges: readonly LiveMdDirtyRange[],
  activeLines: Set<number>,
  precomputedCodeFenceHighlights: readonly CodeFenceHighlightTree[] = [],
): LiveMdAnalysis {
  let codeFenceLanguages = state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages;
  let plan = buildLiveMdPlan(
    state,
    activeLines,
    codeFenceLanguages,
    expandedDirtyRanges,
    previous.codeFenceHighlightTrees,
    changes,
    precomputedCodeFenceHighlights,
  );
  return {
    activeLines,
    atomicRanges: patchRangeSet(
      previous.atomicRanges.map(changes),
      expandedDirtyRanges,
      plan.finishAtomicRangeValues(),
    ),
    codeFenceHighlightTrees: mergeCodeFenceHighlightTrees(
      previous.codeFenceHighlightTrees,
      changes,
      expandedDirtyRanges,
      plan.finishCodeFenceHighlightTrees(),
    ),
    codeFenceLanguages,
    decorations: patchRangeSet(
      previous.decorations.map(changes),
      expandedDirtyRanges,
      plan.finishDecorationRanges(),
    ),
    dirtyRanges,
    expandedDirtyRanges,
  };
}

function buildLiveMdPlan(
  state: EditorState,
  activeLines: Set<number>,
  codeFenceLanguages: CodeFenceLanguageMap,
  ranges?: readonly LiveMdDirtyRange[],
  previousCodeFenceHighlights: readonly CodeFenceHighlightTree[] = [],
  changes: ChangeDesc | null = null,
  precomputedCodeFenceHighlights: readonly CodeFenceHighlightTree[] = [],
) {
  let context: VisitContext = {
    activeLines,
    codeFenceHighlightCache: codeFenceHighlightCache(precomputedCodeFenceHighlights),
    codeFenceLanguages,
    dirtyRange: null,
    dirtyReasons: null,
    linkBaseUrl: state.facet(liveMdLinkBaseUrl),
    plannedCodeFenceHighlightKeys: new Set(),
    previousCodeFenceHighlights,
    changes,
    plan: new DecorationPlan(state),
    state,
  };

  let tree = syntaxTree(state);
  let iterate = (from?: number, to?: number) => {
    tree.iterate({
      from,
      to,
      enter(node) {
        return liveMdFeatureRegistry.enter(context, node);
      },
    });
  };
  if (ranges) {
    for (let range of ranges) {
      context.dirtyRange = range;
      context.dirtyReasons = range.reasons;
      context.plan.setDirtyRange(range);
      iterate(range.from, range.to);
    }
    context.dirtyRange = null;
    context.dirtyReasons = null;
    context.plan.setDirtyRange(null);
  } else {
    iterate();
  }

  return context.plan;
}

function mergeCodeFenceHighlightTrees(
  previous: readonly CodeFenceHighlightTree[],
  changes: ChangeDesc,
  dirtyRanges: readonly LiveMdDirtyRange[],
  additions: readonly CodeFenceHighlightTree[],
) {
  if (!dirtyRanges.length) return previous;
  let invalidatingDirtyRanges = dirtyRanges.filter(codeFenceHighlightInvalidatingRange);
  let preserved = previous
    .map((tree) => ({
      ...tree,
      contentFrom: changes.mapPos(tree.contentFrom, 1),
      contentTo: changes.mapPos(tree.contentTo, -1),
    }))
    .filter(
      (tree) => !touchesAnyDirtyRange(tree.contentFrom, tree.contentTo, invalidatingDirtyRanges),
    );
  return [...preserved, ...additions].sort(
    (left, right) => left.contentFrom - right.contentFrom || left.contentTo - right.contentTo,
  );
}

function codeFenceHighlightInvalidatingRange(range: LiveMdDirtyRange) {
  return range.reasons.some((reason) => reason != "selection");
}

function touchesAnyDirtyRange(from: number, to: number, dirtyRanges: readonly LiveMdDirtyRange[]) {
  return dirtyRanges.some((range) => rangesTouch(from, to, range.from, range.to));
}

function analyzeCodeFenceSyntaxChanges(
  state: EditorState,
  changes: ChangeDesc,
  previousHighlights: readonly CodeFenceHighlightTree[],
): CodeFenceSyntaxChanges {
  if (!previousHighlights.length) return emptyCodeFenceSyntaxChanges;

  let highlights: CodeFenceHighlightTree[] = [];
  let sourceRanges: LiveMdDirtySourceRange[] = [];
  for (let previous of previousHighlights) {
    let contentFrom = changes.mapPos(previous.contentFrom, 1);
    let contentTo = changes.mapPos(previous.contentTo, -1);
    if (contentFrom >= contentTo) continue;

    let contentChanges = codeFenceContentChangeResult(
      changes,
      state,
      previous,
      contentFrom,
      contentTo,
    );
    if (!contentChanges || !contentChanges.touched) continue;

    let sourceText = codeFenceSourceText(state, contentFrom, contentTo);
    let oldTree = previous.parser.editWrappedTree(
      previous.tree,
      contentChanges.changes,
      previous.sourceText,
      sourceText,
    );
    let tree = previous.parser.parse(sourceText, oldTree);
    let highlight = {
      ...previous,
      contentFrom,
      contentTo,
      sourceText,
      tree,
    };
    highlights.push(highlight);
    let changedRanges = oldTree.tree
      ? oldTree.tree.getChangedRanges(tree.tree!)
      : [{ startIndex: 0, endIndex: tree.length }];
    if (!changedRanges.length) continue;

    let rangeFrom = Math.min(...changedRanges.map((range) => range.startIndex));
    sourceRanges.push({
      from: contentFrom + rangeFrom,
      reason: "syntax",
      to: codeFenceContentDirtyTo(state, contentTo),
    });
  }

  return highlights.length || sourceRanges.length
    ? { highlights, sourceRanges }
    : emptyCodeFenceSyntaxChanges;
}

function feature(
  nodes: readonly string[],
  enter?: NodeVisitor,
  scope?: LiveMdScope,
  invalidatedBy?: readonly string[],
): LiveMdNodeFeature {
  return { enter, invalidatedBy, nodes, scope };
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

function isBlockNode(node: SyntaxNode) {
  switch (node.name) {
    case "atx_heading":
    case "block_quote":
    case "fenced_code_block":
    case "list":
    case "paragraph":
    case "pipe_table":
    case "setext_heading":
    case "thematic_break":
      return true;
    default:
      return false;
  }
}

function isDocumentChildNode(node: SyntaxNode) {
  return node.name == "section" || isBlockNode(node);
}

function compressGaps(
  context: VisitContext,
  parent: SyntaxNode,
  isSibling: (node: SyntaxNode) => boolean,
  previousFrom: (context: VisitContext, node: SyntaxNode) => number = blockBreakFrom,
  containerTo?: number,
) {
  let siblings = siblingWindowForGaps(context, parent, isSibling);
  for (let index = 1; index < siblings.length; index++) {
    let previous = siblings[index - 1];
    let current = siblings[index];
    markDirtyParagraphBreakRun(context, previousFrom(context, previous), current.from);
  }

  let last = siblings.at(-1);
  if (last && containerTo != null && !nextMatchingSibling(last, isSibling)) {
    markDirtyParagraphBreakRun(context, previousFrom(context, last), containerTo);
  }
}

function visitDocument(context: VisitContext, node: SyntaxNode) {
  compressGaps(context, node, isDocumentChildNode, blockBreakFrom, node.to);
}

function visitSection(context: VisitContext, node: SyntaxNode) {
  compressGaps(context, node, isBlockNode, blockBreakFrom, node.to);
}

function visitList(context: VisitContext, node: SyntaxNode) {
  compressGaps(
    context,
    node,
    (child) => child.name == "list_item",
    blockContainerBreakFrom,
    node.to,
  );
}

function visitBlockQuote(context: VisitContext, node: SyntaxNode) {
  context.plan.lineClass(node.from, node.to, "cm-md-blockquote");
  compressGaps(context, node, isBlockNode, blockBreakFrom, node.to);
}

function siblingWindowForGaps(
  context: VisitContext,
  parent: SyntaxNode,
  isSibling: (node: SyntaxNode) => boolean,
) {
  let range = context.dirtyRange;
  if (!range) return matchingChildren(parent, isSibling);

  let seed = firstChildTouchingOrAfter(parent, range.from) ?? parent.lastChild;
  while (seed && !isSibling(seed)) seed = seed.previousSibling;
  let first = seed ? (previousMatchingSibling(seed, isSibling) ?? seed) : null;
  if (!first) first = firstMatchingChild(parent, isSibling);

  let siblings: SyntaxNode[] = [];
  for (let child = first; child; child = nextMatchingSibling(child, isSibling)) {
    siblings.push(child);
    if (child.from > range.to) break;
  }
  return siblings;
}

function matchingChildren(parent: SyntaxNode, isSibling: (node: SyntaxNode) => boolean) {
  let children: SyntaxNode[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (isSibling(child)) children.push(child);
  }
  return children;
}

function firstMatchingChild(parent: SyntaxNode, isSibling: (node: SyntaxNode) => boolean) {
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (isSibling(child)) return child;
  }
  return null;
}

function firstChildTouchingOrAfter(parent: SyntaxNode, from: number) {
  let index = from > parent.from ? from - 1 : from;
  let child = parent.firstChildForIndex(index);
  while (child && child.to < from) child = child.nextSibling;
  return child;
}

function previousMatchingSibling(node: SyntaxNode, isSibling: (node: SyntaxNode) => boolean) {
  for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
    if (isSibling(sibling)) return sibling;
  }
  return null;
}

function nextMatchingSibling(node: SyntaxNode, isSibling: (node: SyntaxNode) => boolean) {
  for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
    if (isSibling(sibling)) return sibling;
  }
  return null;
}

function blockBreakFrom(context: VisitContext, node: SyntaxNode): number {
  if (node.to <= node.from) return node.to;
  let before = node.to - 1;
  if (context.state.sliceDoc(before, node.to) != "\n") return node.to;
  return context.state.doc.lineAt(before).to;
}

function blockContainerBreakFrom(context: VisitContext, node: SyntaxNode) {
  let blocks = node.children.filter(isBlockNode);
  return blocks.length ? blockBreakFrom(context, blocks[blocks.length - 1]) : node.to;
}

function markParagraphBreakRun(context: VisitContext, from: number, to: number) {
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
    context.plan.atom(newlinePositions[index * 2], newlinePositions[index * 2 + 1] + 1);

    let separatorLine = blankLines[index * 2];
    if (separatorLine == null) return;
    context.plan.line(separatorLine, "cm-md-block-separator");
  }
}

function markDirtyParagraphBreakRun(context: VisitContext, from: number, to: number) {
  let range = context.dirtyRange;
  if (range && !rangesTouch(from, to, range.from, range.to)) return;
  markParagraphBreakRun(context, from, to);
}

function visitLineClass(className: string): NodeVisitor {
  return (context, node) => {
    context.plan.lineClass(node.from, node.to, className);
  };
}

function visitMark(decoration: Decoration): NodeVisitor {
  return (context, node) => {
    context.plan.mark(node.from, node.to, decoration);
  };
}

function visitSyntax(context: VisitContext, node: SyntaxNode) {
  context.plan.syntax(node.from, node.to, context.activeLines);
}

function visitHeading(context: VisitContext, node: SyntaxNode) {
  let marker = node.children.find((child) => child.name.startsWith("atx_h"));
  let level = marker ? Number(marker.name.at(5)) || 1 : 1;
  context.plan.lineClass(node.from, node.to, "cm-md-heading");
  context.plan.lineClass(node.from, node.to, `cm-md-heading-${level}`);
  if (marker) context.plan.syntax(marker.from, marker.to, context.activeLines);
}

function visitSetextHeading(context: VisitContext, node: SyntaxNode) {
  let underline = node.children.find((child) => child.name.startsWith("setext_h"));
  let level = underline?.name == "setext_h2_underline" ? 2 : 1;
  context.plan.lineClass(node.from, node.to, "cm-md-heading");
  context.plan.lineClass(node.from, node.to, `cm-md-heading-${level}`);
  if (underline) context.plan.syntax(underline.from, underline.to, context.activeLines);
}

function visitListMarker(context: VisitContext, node: SyntaxNode) {
  let line = context.state.doc.lineAt(node.from);
  context.plan.line(line.number, "cm-md-list-line");
  if (context.activeLines.has(line.number)) {
    context.plan.syntax(node.from, node.to, context.activeLines);
  } else {
    context.plan.replace(
      node.from,
      node.to,
      new ListMarkerWidget(context.state.sliceDoc(node.from, node.to).trim()),
    );
  }
}

function visitTaskMarker(context: VisitContext, node: SyntaxNode) {
  let line = context.state.doc.lineAt(node.from);
  let checked = node.name == "task_list_marker_checked";
  context.plan.line(line.number, "cm-md-list-line");
  context.plan.line(line.number, "cm-md-task-line");
  if (checked) context.plan.line(line.number, "is-checked");
  context.plan.replace(node.from, node.to, new TaskCheckboxWidget(checked));
}

function visitRule(context: VisitContext, node: SyntaxNode): false {
  context.plan.lineClass(node.from, node.to, "cm-md-rule-line");
  context.plan.syntax(node.from, node.to, context.activeLines);
  return false;
}

function visitInlineLink(context: VisitContext, node: SyntaxNode) {
  let text = node.getChild("link_text");
  let destination = node.getChild("link_destination");
  if (!text) return;
  context.plan.syntax(node.from, text.from, context.activeLines);
  context.plan.mark(
    text.from,
    text.to,
    liveMdLinkMark(
      destination ? context.state.sliceDoc(destination.from, destination.to) : null,
      context.linkBaseUrl,
    ),
  );
  context.plan.syntax(text.to, node.to, context.activeLines);
}

function visitUriAutolink(context: VisitContext, node: SyntaxNode) {
  if (node.to - node.from <= 2) return;
  context.plan.syntax(node.from, node.from + 1, context.activeLines);
  context.plan.mark(
    node.from + 1,
    node.to - 1,
    liveMdLinkMark(context.state.sliceDoc(node.from + 1, node.to - 1), context.linkBaseUrl),
  );
  context.plan.syntax(node.to - 1, node.to, context.activeLines);
}

function visitImage(context: VisitContext, node: SyntaxNode): false | void {
  let description = node.getChild("image_description");
  let destination = node.getChild("link_destination");
  let alt = description ? context.state.sliceDoc(description.from, description.to) : "";
  let src = destination ? context.state.sliceDoc(destination.from, destination.to).trim() : "";
  if (!src) return false;

  let line = context.state.doc.lineAt(node.from);
  let active = context.activeLines.has(line.number);
  let widget = new ImagePreviewWidget(alt, normalizeImageSource(src));
  if (
    !active &&
    isOnlyVisibleContentOnLine(context.state, line.from, line.to, node.from, node.to)
  ) {
    context.plan.replace(line.from, line.to, widget, true);
    return false;
  }

  if (!active) {
    context.plan.replace(node.from, node.to, widget);
    return false;
  }

  if (description) {
    context.plan.syntax(node.from, description.from, context.activeLines);
    context.plan.mark(description.from, description.to, liveMdLinkMark(null, context.linkBaseUrl));
    context.plan.syntax(description.to, node.to, context.activeLines);
  }
  return false;
}

function visitLatex(context: VisitContext, node: SyntaxNode): false | void {
  let formula = readLatexFormula(context.state, node);
  if (!formula) return false;
  if (rangeTouchesActiveLine(context, node.from, node.to)) return;

  let range = latexReplacementRange(context.state, node, formula.displayMode);
  context.plan.replace(
    range.from,
    range.to,
    new LatexWidget({ ...formula, block: range.block }),
    range.block,
  );
  return false;
}

function visitTable(context: VisitContext, node: SyntaxNode): false {
  let table = readTableFromNode(context.state, node);
  if (table && !rangeTouchesActiveLine(context, node.from, node.to)) {
    context.plan.replace(node.from, node.to, new TablePreviewWidget(table), true);
    return false;
  }

  let delimiterNode = node.getChild("pipe_table_delimiter_row");
  context.plan.lineClass(node.from, node.to, "cm-md-table-line");
  if (delimiterNode) {
    context.plan.lineClass(delimiterNode.from, delimiterNode.to, "cm-md-table-divider");
  }
  forEachDescendant(node, (child) => {
    if (child.name == "|") {
      context.plan.syntax(child.from, child.to, context.activeLines, tablePipeMark);
    }
  });
  return false;
}

function visitCodeFence(context: VisitContext, node: SyntaxNode): false {
  let delimiters = node.children.filter((child) => child.name == "fenced_code_block_delimiter");
  let openingDelimiter = delimiters[0];
  if (!openingDelimiter) return false;

  let closingDelimiter = delimiters[1] ?? null;
  let content = node.getChild("code_fence_content");
  let language = readFenceLanguage(context.state, node);

  if (content && content.from < content.to) {
    let diagram = readMermaidDiagram(context.state, content, language);
    if (diagram && !rangeTouchesActiveLine(context, node.from, node.to)) {
      context.plan.replace(node.from, node.to, new MermaidWidget(diagram), true);
      return false;
    }
  }

  let openingLineNumber = context.state.doc.lineAt(openingDelimiter.from).number;
  let blockEndLineNumber = openingLineNumber;

  context.plan.line(openingLineNumber, "cm-md-code-fence-line");
  context.plan.line(openingLineNumber, "cm-md-code-block-start");
  context.plan.syntax(openingDelimiter.from, openingDelimiter.to, context.activeLines);

  if (content && content.from < content.to) {
    forEachLineInRange(context.state, content.from, content.to, (line) => {
      context.plan.line(line.number, "cm-md-code-line");
      blockEndLineNumber = line.number;
    });
    addCodeFenceHighlights(context, content.from, content.to, language);
  }

  if (closingDelimiter) {
    let closingLineNumber = context.state.doc.lineAt(closingDelimiter.from).number;
    blockEndLineNumber = closingLineNumber;
    context.plan.line(closingLineNumber, "cm-md-code-fence-line");
    context.plan.syntax(closingDelimiter.from, closingDelimiter.to, context.activeLines);
  }

  context.plan.line(blockEndLineNumber, "cm-md-code-block-end");
  return false;
}

function readLatexFormula(
  state: EditorState,
  node: SyntaxNode,
): Omit<LatexFormula, "block"> | null {
  let delimiters = node.children.filter((child) => child.name == "latex_span_delimiter");
  let openingDelimiter = delimiters[0];
  let closingDelimiter = delimiters[delimiters.length - 1];
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

function isSelectionOnlyVisit(context: VisitContext) {
  return (
    context.dirtyReasons != null &&
    context.dirtyReasons.length > 0 &&
    context.dirtyReasons.every((reason) => reason == "selection")
  );
}

function readTableFromNode(state: EditorState, node: SyntaxNode): MarkdownTable | null {
  let headerNode = node.getChild("pipe_table_header");
  let delimiterNode = node.getChild("pipe_table_delimiter_row");
  if (!headerNode || !delimiterNode) return null;

  let header = tableCellsFromNode(state, headerNode, "pipe_table_cell");
  let alignments = tableAlignmentsFromNode(delimiterNode);
  if (header.length < 2 || alignments.length < 2) return null;

  let columnCount = Math.max(header.length, alignments.length);
  return {
    alignments: normalizeTableAlignments(alignments, columnCount),
    header: normalizeTableCells(header, columnCount),
    rows: node.children
      .filter((child) => child.name == "pipe_table_row")
      .map((row) =>
        normalizeTableCells(tableCellsFromNode(state, row, "pipe_table_cell"), columnCount),
      ),
  };
}

function tableCellsFromNode(state: EditorState, node: SyntaxNode, cellName: string) {
  return node.children
    .filter((child) => child.name == cellName)
    .map((cell) => state.sliceDoc(cell.from, cell.to).trim());
}

function forEachDescendant(node: SyntaxNode, visit: (node: SyntaxNode) => void) {
  for (let child of node.children) {
    visit(child);
    forEachDescendant(child, visit);
  }
}

function tableAlignmentsFromNode(node: SyntaxNode) {
  return node.children
    .filter((child) => child.name == "pipe_table_delimiter_cell")
    .map((cell): "center" | "default" | "left" | "right" => {
      let left = cell.children.some((child) => child.name == "pipe_table_align_left");
      let right = cell.children.some((child) => child.name == "pipe_table_align_right");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "default";
    });
}

function readFenceLanguage(state: EditorState, node: SyntaxNode) {
  let infoString = node.getChild("info_string");
  let languageNode = infoString?.getChild("language") ?? infoString;
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
  context: VisitContext,
  contentFrom: number,
  contentTo: number,
  language: string,
) {
  let highlight = getCodeFenceHighlight(context, contentFrom, contentTo, language);
  if (!highlight) return;

  let { sourceText, tree } = highlight;
  let range = codeFenceHighlightRange(context, contentFrom, sourceText.length);
  if (!range) return;

  highlightTree(
    tree,
    gruvboxLightHighlightStyle,
    (from, to, className) => {
      let decoration = Decoration.mark({ class: className });
      splitTextRangeByLine(sourceText, from, to, (rangeFrom, rangeTo) => {
        context.plan.mark(contentFrom + rangeFrom, contentFrom + rangeTo, decoration);
      });
    },
    range.from,
    range.to,
  );
}

function getCodeFenceHighlight(
  context: VisitContext,
  contentFrom: number,
  contentTo: number,
  language: string,
) {
  let parser = context.codeFenceLanguages.get(language);
  if (!parser || contentFrom >= contentTo) return null;

  let key = codeFenceHighlightKey(contentFrom, contentTo, language);
  let cached = context.codeFenceHighlightCache.get(key);
  if (cached) {
    recordCodeFenceHighlight(context, key, cached);
    return cached;
  }

  let previous = previousCodeFenceHighlight(context, contentFrom, contentTo, language, parser);
  if (previous && isSelectionOnlyVisit(context)) return previous;

  let sourceText = codeFenceSourceText(context.state, contentFrom, contentTo);
  let oldTree = previous
    ? editedPreviousCodeFenceTree(context, previous, contentFrom, contentTo, sourceText)
    : null;
  let tree = parser.parse(sourceText, oldTree);
  let highlight = {
    contentFrom,
    contentTo,
    language,
    parser,
    sourceText,
    tree,
  };
  context.codeFenceHighlightCache.set(key, highlight);
  recordCodeFenceHighlight(context, key, highlight);
  return highlight;
}

function recordCodeFenceHighlight(
  context: VisitContext,
  key: string,
  highlight: CodeFenceHighlightTree,
) {
  if (context.plannedCodeFenceHighlightKeys.has(key)) return;
  context.plannedCodeFenceHighlightKeys.add(key);
  context.plan.codeFenceHighlight(highlight);
}

function codeFenceHighlightCache(highlights: readonly CodeFenceHighlightTree[]) {
  return new Map(
    highlights.map((highlight) => [
      codeFenceHighlightKey(highlight.contentFrom, highlight.contentTo, highlight.language),
      highlight,
    ]),
  );
}

function codeFenceHighlightKey(contentFrom: number, contentTo: number, language: string) {
  return `${contentFrom}:${contentTo}:${language}`;
}

function codeFenceSourceText(state: EditorState, contentFrom: number, contentTo: number) {
  return Text.of(state.sliceDoc(contentFrom, contentTo).split("\n"));
}

function codeFenceContentDirtyTo(state: EditorState, contentTo: number) {
  if (contentTo <= 0) return contentTo;
  return state.sliceDoc(contentTo - 1, contentTo) == "\n" ? contentTo - 1 : contentTo;
}

function codeFenceHighlightRange(context: VisitContext, contentFrom: number, sourceLength: number) {
  let range = context.dirtyRange;
  if (!range) return { from: 0, to: sourceLength };
  let from = Math.max(0, range.from - contentFrom);
  let to = Math.min(sourceLength, range.to - contentFrom);
  return from < to ? { from, to } : null;
}

function previousCodeFenceHighlight(
  context: VisitContext,
  contentFrom: number,
  contentTo: number,
  language: string,
  parser: CodeFenceParser,
) {
  for (let previous of context.previousCodeFenceHighlights) {
    if (previous.language != language || previous.parser != parser) continue;
    let mappedFrom = context.changes?.mapPos(previous.contentFrom, 1) ?? previous.contentFrom;
    let mappedTo = context.changes?.mapPos(previous.contentTo, -1) ?? previous.contentTo;
    if (rangesTouch(mappedFrom, mappedTo, contentFrom, contentTo)) return previous;
  }
  return null;
}

function editedPreviousCodeFenceTree(
  context: VisitContext,
  previous: CodeFenceHighlightTree,
  contentFrom: number,
  contentTo: number,
  sourceText: Text,
) {
  if (!context.changes) return previous.tree;
  let contentChanges = codeFenceContentChanges(context, previous, contentFrom, contentTo);
  if (!contentChanges) return null;
  return previous.parser.editWrappedTree(
    previous.tree,
    contentChanges,
    previous.sourceText,
    sourceText,
  );
}

function codeFenceContentChanges(
  context: VisitContext,
  previous: CodeFenceHighlightTree,
  contentFrom: number,
  contentTo: number,
) {
  return (
    codeFenceContentChangeResult(context.changes, context.state, previous, contentFrom, contentTo)
      ?.changes ?? null
  );
}

function codeFenceContentChangeResult(
  changes: ChangeDesc | null,
  state: EditorState,
  previous: CodeFenceHighlightTree,
  contentFrom: number,
  contentTo: number,
): CodeFenceContentChangeResult | null {
  if (!changes) {
    return {
      changes: ChangeSet.empty(previous.sourceText.length),
      touched: false,
    };
  }
  let specs: Array<{ from: number; insert: string; to: number }> = [];
  let touched = false;
  let usable = true;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    let oldInside = fromA >= previous.contentFrom && toA <= previous.contentTo;
    let newInside = fromB >= contentFrom && toB <= contentTo;
    let touchesOldContent =
      oldInside || rangesTouch(fromA, toA, previous.contentFrom, previous.contentTo);
    let touchesNewContent = newInside || rangesTouch(fromB, toB, contentFrom, contentTo);
    if (!touchesOldContent && !touchesNewContent) return;
    touched = true;
    if (!oldInside || !newInside) {
      usable = false;
      return;
    }
    specs.push({
      from: fromA - previous.contentFrom,
      insert: state.sliceDoc(fromB, toB),
      to: toA - previous.contentFrom,
    });
  });
  return usable
    ? {
        changes: ChangeSet.of(specs, previous.sourceText.length),
        touched,
      }
    : null;
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

function rangeTouchesActiveLine(context: VisitContext, from: number, to: number) {
  let firstLine = context.state.doc.lineAt(from).number;
  let lastLine = context.state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber of context.activeLines) {
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
