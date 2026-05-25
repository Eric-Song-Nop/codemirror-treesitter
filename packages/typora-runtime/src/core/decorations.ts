import { EditorState, RangeSetBuilder, Text } from "@codemirror/state";
import { highlightTree, syntaxTree, type SyntaxNode } from "@codemirror-treesitter/language";
import { gruvboxLightHighlightStyle } from "@codemirror-treesitter/theme-gruvbox";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import {
  codeFenceLanguagesField,
  emptyCodeFenceLanguages,
  type CodeFenceLanguageMap,
} from "./languages.js";
import { forEachLineInRange, isWhitespace, isWhitespaceOnly, splitRangeByLine } from "./util.js";
import {
  ImagePreviewWidget,
  ListMarkerWidget,
  TablePreviewWidget,
  TaskCheckboxWidget,
  type MarkdownTable,
} from "./widgets.js";

type InlineDecoration = {
  from: number;
  to: number;
  decoration: Decoration;
};

type VisitContext = {
  activeLines: Set<number>;
  codeFenceLanguages: CodeFenceLanguageMap;
  plan: DecorationPlan;
  state: EditorState;
};

type NodeVisitor = (context: VisitContext, node: SyntaxNode) => false | void;

const visibleSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" });
const hiddenSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-hidden" });
const strongMark = Decoration.mark({ class: "cm-md-strong" });
const emphasisMark = Decoration.mark({ class: "cm-md-emphasis" });
const strikeMark = Decoration.mark({ class: "cm-md-strike" });
const inlineCodeMark = Decoration.mark({ class: "cm-md-inline-code" });
const linkMark = Decoration.mark({ class: "cm-md-link" });
const tablePipeMark = Decoration.mark({ class: "cm-md-table-pipe" });

const codeFenceHighlightCache = new WeakMap<Text, Map<string, InlineDecoration[]>>();

export const typoraDecorations = EditorView.decorations.compute(
  ["doc", "selection", codeFenceLanguagesField],
  (state) => buildTyporaDecorations(state),
);

const visitors: Record<string, NodeVisitor> = {
  atx_heading: visitHeading,
  block_continuation: visitSyntax,
  block_quote: visitLineClass("cm-md-blockquote"),
  block_quote_marker: visitSyntax,
  code_span: visitMark(inlineCodeMark),
  code_span_delimiter: visitSyntax,
  emphasis: visitMark(emphasisMark),
  emphasis_delimiter: visitSyntax,
  fenced_code_block: visitCodeFence,
  image: visitImage,
  inline_link: visitInlineLink,
  list_item: visitLineClass("cm-md-list-line"),
  list_marker_dot: visitListMarker,
  list_marker_minus: visitListMarker,
  list_marker_parenthesis: visitListMarker,
  list_marker_plus: visitListMarker,
  list_marker_star: visitListMarker,
  pipe_table: visitTable,
  setext_heading: visitSetextHeading,
  strikethrough: visitMark(strikeMark),
  strong_emphasis: visitMark(strongMark),
  task_list_marker_checked: visitTaskMarker,
  task_list_marker_unchecked: visitTaskMarker,
  thematic_break: visitRule,
  uri_autolink: visitUriAutolink,
};

class DecorationPlan {
  private lineClasses = new Map<number, Set<string>>();
  private ranges: InlineDecoration[] = [];
  private state: EditorState;

  constructor(state: EditorState) {
    this.state = state;
  }

  line(lineNumber: number, className: string) {
    let classes = this.lineClasses.get(lineNumber);
    if (!classes) this.lineClasses.set(lineNumber, (classes = new Set()));
    classes.add(className);
  }

  lineClass(from: number, to: number, className: string) {
    forEachLineInRange(this.state, from, to, (line) => this.line(line.number, className));
  }

  mark(from: number, to: number, decoration: Decoration) {
    if (from < to) this.ranges.push({ from, to, decoration });
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

    let builder = new RangeSetBuilder<Decoration>();
    for (let { from, to, decoration } of decorations) {
      builder.add(from, to, decoration);
    }
    return builder.finish();
  }
}

function buildTyporaDecorations(state: EditorState): DecorationSet {
  let activeLines = getActiveLines(state);
  let context: VisitContext = {
    activeLines,
    codeFenceLanguages: state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages,
    plan: new DecorationPlan(state),
    state,
  };

  syntaxTree(state).iterate({
    enter(node) {
      return visitors[node.name]?.(context, node);
    },
  });

  return context.plan.finish();
}

function getActiveLines(state: EditorState) {
  let lines = new Set<number>();
  for (let range of state.selection.ranges) {
    lines.add(state.doc.lineAt(range.head).number);
  }
  return lines;
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
  context.plan.replace(node.from, node.to, new TaskCheckboxWidget(checked, node.from));
}

function visitRule(context: VisitContext, node: SyntaxNode): false {
  context.plan.lineClass(node.from, node.to, "cm-md-rule-line");
  context.plan.syntax(node.from, node.to, context.activeLines);
  return false;
}

function visitInlineLink(context: VisitContext, node: SyntaxNode) {
  let text = node.getChild("link_text");
  if (!text) return;
  context.plan.syntax(node.from, text.from, context.activeLines);
  context.plan.mark(text.from, text.to, linkMark);
  context.plan.syntax(text.to, node.to, context.activeLines);
}

function visitUriAutolink(context: VisitContext, node: SyntaxNode) {
  if (node.to - node.from <= 2) return;
  context.plan.syntax(node.from, node.from + 1, context.activeLines);
  context.plan.mark(node.from + 1, node.to - 1, linkMark);
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
    context.plan.mark(description.from, description.to, linkMark);
    context.plan.syntax(description.to, node.to, context.activeLines);
  }
  return false;
}

function visitTable(context: VisitContext, node: SyntaxNode): false {
  let table = readTableFromNode(context.state, node);
  if (table && !rangeTouchesActiveLine(context, node.from, node.to)) {
    context.plan.replace(node.from, node.to, new TablePreviewWidget(table, node.from), true);
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

  context.plan.line(
    context.state.doc.lineAt(openingDelimiter.from).number,
    "cm-md-code-fence-line",
  );
  context.plan.syntax(openingDelimiter.from, openingDelimiter.to, context.activeLines);

  if (content && content.from < content.to) {
    forEachLineInRange(context.state, content.from, content.to, (line) => {
      context.plan.line(line.number, "cm-md-code-line");
    });
    addCodeFenceHighlights(
      context,
      content.from,
      content.to,
      readFenceLanguage(context.state, node),
    );
  }

  if (closingDelimiter) {
    context.plan.line(
      context.state.doc.lineAt(closingDelimiter.from).number,
      "cm-md-code-fence-line",
    );
    context.plan.syntax(closingDelimiter.from, closingDelimiter.to, context.activeLines);
  }
  return false;
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
  let parser = context.codeFenceLanguages.get(language);
  if (!parser || contentFrom >= contentTo) return;

  let source = context.state.sliceDoc(contentFrom, contentTo);
  let ranges = getCodeFenceHighlightRanges(
    context.state.doc,
    contentFrom,
    contentTo,
    language,
    source,
    () => {
      let sourceText = Text.of(source.split("\n"));
      let tree = parser.parse(sourceText);
      let parsedRanges: InlineDecoration[] = [];
      highlightTree(tree, gruvboxLightHighlightStyle, (from, to, className) => {
        splitTextRangeByLine(sourceText, from, to, (rangeFrom, rangeTo) => {
          parsedRanges.push({
            from: rangeFrom,
            to: rangeTo,
            decoration: Decoration.mark({ class: className }),
          });
        });
      });
      return parsedRanges;
    },
  );

  for (let range of ranges) {
    context.plan.mark(contentFrom + range.from, contentFrom + range.to, range.decoration);
  }
}

function getCodeFenceHighlightRanges(
  doc: Text,
  contentFrom: number,
  contentTo: number,
  language: string,
  source: string,
  parse: () => InlineDecoration[],
) {
  let key = `${contentFrom}:${contentTo}:${language}:${source}`;
  let docCache = codeFenceHighlightCache.get(doc);
  if (!docCache) codeFenceHighlightCache.set(doc, (docCache = new Map()));
  let cached = docCache.get(key);
  if (cached) return cached;
  let ranges = parse();
  docCache.set(key, ranges);
  return ranges;
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
