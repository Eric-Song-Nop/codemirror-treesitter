import {
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import { closeBrackets, closeBracketsKeymap } from "@codemirror-treesitter/autocomplete";
import { minimalSetup } from "@codemirror-treesitter/basic-setup";
import { indentWithTab } from "@codemirror-treesitter/commands";
import {
  syntaxTree,
  TreeSitterLanguage,
  type TreeSitterParser,
  highlightTree,
  type SyntaxNode,
} from "@codemirror-treesitter/language";
import { languages } from "@codemirror-treesitter/language-data";
import { gruvboxLightHighlightStyle } from "@codemirror-treesitter/theme-gruvbox";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  type Command,
  type DecorationSet,
} from "@codemirror/view";
import heroUrl from "./assets/hero.png";

type InlineDecoration = {
  from: number;
  to: number;
  decoration: Decoration;
};

type MarkdownTable = {
  alignments: Array<"center" | "default" | "left" | "right">;
  header: string[];
  rows: string[][];
};

type VisitContext = {
  activeLines: Set<number>;
  codeFenceLanguages: CodeFenceLanguageMap;
  plan: DecorationPlan;
  state: EditorState;
};

type CodeFenceLanguageMap = ReadonlyMap<string, TreeSitterParser>;
type NodeVisitor = (context: VisitContext, node: SyntaxNode) => false | void;

type LineMarkers = {
  inCode: boolean;
  listMarker: { from: number; text: string; to: number } | null;
  quoteTo: number | null;
  task: { checked: boolean; from: number; to: number } | null;
};

const storageKey = "codemirror-treesitter-typora-demo-v2";
const markdownDescription = languages.find((language) => language.name == "Markdown");
const emptyCodeFenceLanguages: CodeFenceLanguageMap = new Map();

const setCodeFenceLanguages = StateEffect.define<CodeFenceLanguageMap>();

const codeFenceLanguagesField = StateField.define<CodeFenceLanguageMap>({
  create() {
    return emptyCodeFenceLanguages;
  },
  update(value, transaction) {
    for (let effect of transaction.effects) {
      if (effect.is(setCodeFenceLanguages)) return effect.value;
    }
    return value;
  },
});

const codeFenceHighlightModule = gruvboxLightHighlightStyle.module
  ? EditorView.styleModule.of(gruvboxLightHighlightStyle.module)
  : [];

const initialMarkdown = `# Typora-style field note

The editor keeps Markdown as the source while the page reads like composed text. It uses **Tree-sitter Markdown** for the CodeMirror language layer, then applies local editing affordances on top.

> Drafting should feel quiet. Markup can stay available without shouting over the prose.

## Inline rhythm

Use _emphasis_, **strong text**, ~~removed words~~, ==highlighted phrases==, \`inline code\`, and [project links](https://viteplus.dev/) in the same writing flow.

![A writing surface](${heroUrl})

## Working list

- [x] Render Markdown blocks in place
- [x] Keep Tree-sitter parsing active
- [ ] Tighten edge cases around nested inline spans
- [ ] Compare more Typora behaviors

1. Keep ordered lists moving.
2. Preserve the author's source text.
3. Make the active line easy to edit.

---

| Markdown shape | Editor treatment |
| --- | --- |
| Heading markers | Hidden away from the active line |
| Task markers | Clickable checkbox widgets |
| Code fences | Paper-like code blocks |

## Nested Markdown

> - [ ] Quote task with **strong _nested emphasis_** and [inline link](https://github.com/lezer-parser)
>   - Child quote item with ==highlight==, \`inline code\`, and ~~struck text~~

- Parent item
  - Child item with **strong [linked text](https://codemirror.net/)** and _soft emphasis_
    - Grandchild keeps markers quiet until the cursor lands there.

\`\`\`ts
type Note = {
  title: string;
  done: boolean;
};

const note: Note = { title: "Tree-sitter Markdown", done: false };
\`\`\`

\`\`\`markdown
### Markdown inside a fence

> Recursive source should still receive Markdown token colors.

- [ ] **Nested** source remains editable as plain fenced text.
\`\`\`
`;

const visibleSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" });
const hiddenSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-hidden" });
const strongMark = Decoration.mark({ class: "cm-md-strong" });
const emphasisMark = Decoration.mark({ class: "cm-md-emphasis" });
const strikeMark = Decoration.mark({ class: "cm-md-strike" });
const highlightMark = Decoration.mark({ class: "cm-md-highlight" });
const inlineCodeMark = Decoration.mark({ class: "cm-md-inline-code" });
const linkMark = Decoration.mark({ class: "cm-md-link" });
const tablePipeMark = Decoration.mark({ class: "cm-md-table-pipe" });

class TaskCheckboxWidget extends WidgetType {
  private checked: boolean;
  private markerFrom: number;

  constructor(checked: boolean, markerFrom: number) {
    super();
    this.checked = checked;
    this.markerFrom = markerFrom;
  }

  eq(other: TaskCheckboxWidget) {
    return other.checked == this.checked && other.markerFrom == this.markerFrom;
  }

  toDOM(view: EditorView) {
    let button = document.createElement("button");
    button.type = "button";
    button.className = this.checked ? "cm-md-task-toggle is-checked" : "cm-md-task-toggle";
    button.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
    button.setAttribute("aria-checked", String(this.checked));
    button.setAttribute("role", "checkbox");
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      view.dispatch({
        changes: {
          from: this.markerFrom + 1,
          to: this.markerFrom + 2,
          insert: this.checked ? " " : "x",
        },
        userEvent: "input.task",
      });
      view.focus();
    });
    return button;
  }

  ignoreEvent() {
    return false;
  }
}

class ListMarkerWidget extends WidgetType {
  private marker: string;

  constructor(marker: string) {
    super();
    this.marker = marker;
  }

  eq(other: ListMarkerWidget) {
    return other.marker == this.marker;
  }

  toDOM() {
    let marker = document.createElement("span");
    let ordered = isAsciiDigit(this.marker.charCodeAt(0));
    marker.className = ordered ? "cm-md-list-marker is-ordered" : "cm-md-list-marker";
    marker.textContent = ordered ? this.marker : "\u2022";
    return marker;
  }
}

class ImagePreviewWidget extends WidgetType {
  private alt: string;
  private src: string;

  constructor(alt: string, src: string) {
    super();
    this.alt = alt;
    this.src = src;
  }

  eq(other: ImagePreviewWidget) {
    return other.alt == this.alt && other.src == this.src;
  }

  toDOM() {
    let figure = document.createElement("figure");
    figure.className = "cm-md-image-preview";

    let image = document.createElement("img");
    image.alt = this.alt;
    image.src = this.src;
    figure.append(image);

    if (this.alt) {
      let caption = document.createElement("figcaption");
      caption.textContent = this.alt;
      figure.append(caption);
    }

    return figure;
  }
}

class TablePreviewWidget extends WidgetType {
  private sourceFrom: number;
  private table: MarkdownTable;
  private tableKey: string;

  constructor(table: MarkdownTable, sourceFrom: number) {
    super();
    this.table = table;
    this.sourceFrom = sourceFrom;
    this.tableKey = JSON.stringify(table);
  }

  eq(other: TablePreviewWidget) {
    return other.tableKey == this.tableKey && other.sourceFrom == this.sourceFrom;
  }

  toDOM(view: EditorView) {
    let wrapper = document.createElement("div");
    wrapper.className = "cm-md-table-preview";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "button");
    wrapper.setAttribute("aria-label", "Edit Markdown table");
    wrapper.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    wrapper.addEventListener("click", () => {
      view.dispatch({
        selection: { anchor: this.sourceFrom },
        scrollIntoView: true,
        userEvent: "select.tablePreview",
      });
      view.focus();
    });

    let table = document.createElement("table");
    let thead = document.createElement("thead");
    let headerRow = document.createElement("tr");
    this.table.header.forEach((cell, index) => {
      let heading = document.createElement("th");
      heading.textContent = cell;
      applyTableAlignment(heading, this.table.alignments[index]);
      headerRow.append(heading);
    });
    thead.append(headerRow);
    table.append(thead);

    let tbody = document.createElement("tbody");
    this.table.rows.forEach((row) => {
      let tableRow = document.createElement("tr");
      row.forEach((cell, index) => {
        let value = document.createElement("td");
        value.textContent = cell;
        applyTableAlignment(value, this.table.alignments[index]);
        tableRow.append(value);
      });
      tbody.append(tableRow);
    });
    table.append(tbody);
    wrapper.append(table);

    return wrapper;
  }
}

const typoraDecorations = StateField.define<DecorationSet>({
  create(state) {
    return buildTyporaDecorations(state);
  },
  update(decorations, transaction) {
    if (
      transaction.docChanged ||
      transaction.selection ||
      transaction.effects.some((effect) => effect.is(setCodeFenceLanguages))
    ) {
      return buildTyporaDecorations(transaction.state);
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const typoraKeymap = keymap.of([
  { key: "Enter", run: continueMarkdownBlock },
  { key: "Mod-b", run: surroundSelection("**", "**", "strong text") },
  { key: "Mod-i", run: surroundSelection("_", "_", "emphasis") },
  { key: "Mod-e", run: surroundSelection("`", "`", "code") },
  { key: "Mod-Shift-x", run: surroundSelection("~~", "~~", "removed text") },
  { key: "Mod-k", run: insertMarkdownLink },
  { key: "Mod-Shift-Enter", run: toggleTaskOnCurrentLine },
  indentWithTab,
]);

function typoraMarkdownExtensions() {
  return [
    typoraKeymap,
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    codeFenceLanguagesField,
    EditorView.contentAttributes.of({
      "aria-label": "Typora-style Markdown editor",
      spellcheck: "true",
    }),
    EditorView.editorAttributes.of({
      class: "typora-codemirror",
    }),
    typoraDecorations,
  ];
}

async function loadCodeFenceLanguages() {
  let languageMap = new Map<string, TreeSitterParser>();
  let aliasesByLanguage = new Map([
    ["CSS", ["css"]],
    ["HTML", ["html", "xhtml"]],
    ["JSON", ["json", "json5"]],
    ["JavaScript", ["javascript", "js", "jsx", "ecmascript", "node"]],
    ["Markdown", ["markdown", "md", "mkd"]],
    ["Python", ["python", "py"]],
    ["Shell", ["shell", "sh", "bash", "zsh"]],
    ["TSX", ["tsx"]],
    ["TypeScript", ["typescript", "ts", "mts", "cts"]],
  ]);

  await Promise.all(
    Array.from(aliasesByLanguage.keys()).map(async (name) => {
      let description = languages.find((language) => language.name == name);
      if (!description) return;

      let support = await description.load();
      if (!(support.language instanceof TreeSitterLanguage)) return;

      let parser = support.language.parser;
      let aliases = new Set([
        name.toLowerCase(),
        ...description.alias.map((alias) => alias.toLowerCase()),
        ...description.extensions.map((extension) => extension.toLowerCase()),
        ...(aliasesByLanguage.get(name) ?? []),
      ]);
      for (let alias of aliases) languageMap.set(alias, parser);
    }),
  );

  return languageMap;
}

export function mountTyporaEditor(parent: HTMLElement) {
  let markdownCompartment = new Compartment();
  let view = new EditorView({
    parent,
    state: EditorState.create({
      doc: loadInitialDoc(),
      extensions: [
        typoraMarkdownExtensions(),
        codeFenceHighlightModule,
        markdownCompartment.of([]),
        minimalSetup,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) saveDoc(update.state.doc.toString());
        }),
      ],
    }),
  });

  view.focus();

  let cancelled = false;
  if (!markdownDescription) {
    console.error("Markdown language support is unavailable");
  } else {
    void markdownDescription
      .load()
      .then((support) => {
        if (cancelled) return;
        view.dispatch({
          effects: markdownCompartment.reconfigure(support.extension),
        });
      })
      .catch((error: unknown) => {
        console.error(error);
      });
  }

  void loadCodeFenceLanguages()
    .then((languageMap) => {
      if (cancelled || !languageMap.size) return;
      view.dispatch({
        effects: setCodeFenceLanguages.of(languageMap),
      });
    })
    .catch((error: unknown) => {
      console.error(error);
    });

  return () => {
    cancelled = true;
    view.destroy();
  };
}

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
  inline: visitTyporaHighlight,
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

function buildTyporaDecorations(state: EditorState) {
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
  lines.add(state.doc.lineAt(state.selection.main.head).number);
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

function visitTyporaHighlight(context: VisitContext, node: SyntaxNode) {
  let parentName = node.parent?.name;
  if (parentName != "paragraph" && parentName != "atx_heading") return;
  addTyporaHighlightRanges(context, node.from, node.to);
}

function addTyporaHighlightRanges(context: VisitContext, from: number, to: number) {
  let text = context.state.sliceDoc(from, to);
  let searchFrom = 0;
  while (searchFrom < text.length) {
    let open = text.indexOf("==", searchFrom);
    if (open < 0) return;
    let close = text.indexOf("==", open + 2);
    if (close < 0) return;
    context.plan.syntax(from + open, from + open + 2, context.activeLines);
    context.plan.mark(from + open + 2, from + close, highlightMark);
    context.plan.syntax(from + close, from + close + 2, context.activeLines);
    searchFrom = close + 2;
  }
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
  let tree = parser.parse(Text.of(source.split("\n")));
  highlightTree(tree, gruvboxLightHighlightStyle, (from, to, className) => {
    context.plan.markByLine(contentFrom + from, contentFrom + to, () =>
      Decoration.mark({ class: className }),
    );
  });
}

function forEachLineInRange(
  state: EditorState,
  from: number,
  to: number,
  visit: (line: { from: number; number: number; to: number }) => void,
) {
  if (from >= to) return;
  let firstLine = state.doc.lineAt(from).number;
  let lastLine = state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
    visit(state.doc.line(lineNumber));
  }
}

function splitRangeByLine(
  state: EditorState,
  from: number,
  to: number,
  visit: (lineNumber: number, from: number, to: number) => void,
) {
  let cursor = from;
  while (cursor < to) {
    let line = state.doc.lineAt(cursor);
    let rangeTo = Math.min(to, line.to);
    if (cursor < rangeTo) visit(line.number, cursor, rangeTo);
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

function isWhitespaceOnly(value: string) {
  for (let index = 0; index < value.length; index++) {
    if (!isWhitespace(value.charCodeAt(index))) return false;
  }
  return true;
}

function isWhitespace(code: number) {
  return code == 9 || code == 10 || code == 13 || code == 32;
}

function readLineMarkers(state: EditorState, line: { from: number; number: number; to: number }) {
  let result: LineMarkers = {
    inCode: lineIsInsideCodeFence(state, line),
    listMarker: null,
    quoteTo: null,
    task: null,
  };

  if (result.inCode) return result;

  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (node.name == "fenced_code_block") return false;
      if (node.from < line.from || node.from > line.to) return;
      switch (node.name) {
        case "block_quote_marker":
        case "block_continuation":
          result.quoteTo = Math.max(result.quoteTo ?? line.from, node.to);
          return;
        case "list_marker_dot":
        case "list_marker_minus":
        case "list_marker_parenthesis":
        case "list_marker_plus":
        case "list_marker_star":
          result.listMarker ??= {
            from: node.from,
            text: state.sliceDoc(node.from, node.to),
            to: node.to,
          };
          return;
        case "task_list_marker_checked":
        case "task_list_marker_unchecked":
          result.task ??= {
            checked: node.name == "task_list_marker_checked",
            from: node.from,
            to: node.to,
          };
          return;
        default:
          return;
      }
    },
  });

  return result;
}

function lineIsInsideCodeFence(
  state: EditorState,
  line: { from: number; number: number; to: number },
) {
  let tree = syntaxTree(state);
  let positions = new Set([line.from, line.to > line.from ? line.to - 1 : line.from]);
  for (let position of positions) {
    let node = tree.resolveInner(position, 1);
    if (hasAncestor(node, "fenced_code_block")) return true;
    node = tree.resolveInner(position, -1);
    if (hasAncestor(node, "fenced_code_block")) return true;
  }
  return false;
}

function hasAncestor(node: SyntaxNode | null, name: string) {
  while (node) {
    if (node.name == name) return true;
    node = node.parent;
  }
  return false;
}

function continueMarkdownBlock(view: EditorView) {
  let { state } = view;
  if (state.selection.ranges.length != 1 || !state.selection.main.empty) return false;

  let cursor = state.selection.main.head;
  let line = state.doc.lineAt(cursor);
  let markers = readLineMarkers(state, line);
  if (markers.inCode) return false;

  let after = state.sliceDoc(cursor, line.to);
  if (isWhitespaceOnly(after)) {
    if (markers.task && isWhitespaceOnly(state.sliceDoc(markers.task.to, cursor))) {
      return clearMarkdownContinuation(view, markers.listMarker?.from ?? markers.task.from, cursor);
    }
    if (markers.listMarker && isWhitespaceOnly(state.sliceDoc(markers.listMarker.to, cursor))) {
      return clearMarkdownContinuation(view, markers.listMarker.from, cursor);
    }
    if (
      !markers.listMarker &&
      markers.quoteTo &&
      isWhitespaceOnly(state.sliceDoc(markers.quoteTo, cursor))
    ) {
      return clearMarkdownContinuation(view, line.from, cursor);
    }
  }

  if (markers.task && markers.listMarker) {
    let prefix = state.sliceDoc(line.from, markers.listMarker.from);
    return insertContinuation(view, cursor, `${prefix}${nextMarker(markers.listMarker.text)}[ ] `);
  }

  if (markers.listMarker) {
    let prefix = state.sliceDoc(line.from, markers.listMarker.from);
    return insertContinuation(view, cursor, `${prefix}${nextMarker(markers.listMarker.text)}`);
  }

  if (markers.quoteTo) {
    return insertContinuation(view, cursor, state.sliceDoc(line.from, markers.quoteTo));
  }

  return false;
}

function clearMarkdownContinuation(view: EditorView, from: number, to: number) {
  view.dispatch({
    changes: { from, to, insert: "" },
    selection: { anchor: from },
    scrollIntoView: true,
    userEvent: "delete.markdownMarker",
  });
  return true;
}

function insertContinuation(view: EditorView, cursor: number, prefix: string) {
  view.dispatch({
    changes: { from: cursor, insert: `\n${prefix}` },
    selection: { anchor: cursor + prefix.length + 1 },
    scrollIntoView: true,
    userEvent: "input.markdownNewline",
  });
  return true;
}

function nextMarker(marker: string) {
  let trimmedEnd = marker.length;
  while (trimmedEnd > 0 && isWhitespace(marker.charCodeAt(trimmedEnd - 1))) trimmedEnd--;
  let suffix = marker.charAt(trimmedEnd - 1);
  if (suffix != "." && suffix != ")") return marker;

  let digitsEnd = trimmedEnd - 1;
  let digitsStart = digitsEnd;
  while (digitsStart > 0 && isAsciiDigit(marker.charCodeAt(digitsStart - 1))) digitsStart--;
  if (digitsStart == digitsEnd || !isWhitespaceOnly(marker.slice(0, digitsStart))) return marker;

  let nextNumber = Number(marker.slice(digitsStart, digitsEnd)) + 1;
  return `${marker.slice(0, digitsStart)}${nextNumber}${suffix}${marker.slice(trimmedEnd)}`;
}

function isAsciiDigit(code: number) {
  return code >= 48 && code <= 57;
}

function surroundSelection(open: string, close: string, placeholder: string): Command {
  return (view) => {
    let transaction = view.state.changeByRange((range) => {
      if (range.empty) {
        let insert = `${open}${placeholder}${close}`;
        return {
          changes: { from: range.from, insert },
          range: EditorSelection.range(
            range.from + open.length,
            range.from + open.length + placeholder.length,
          ),
        };
      }

      let selected = view.state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: `${open}${selected}${close}` },
        range: EditorSelection.range(range.from + open.length, range.to + open.length),
      };
    });

    view.dispatch({ ...transaction, scrollIntoView: true, userEvent: "input.markdownWrap" });
    return true;
  };
}

function insertMarkdownLink(view: EditorView) {
  let transaction = view.state.changeByRange((range) => {
    let label = range.empty ? "link" : view.state.sliceDoc(range.from, range.to);
    let insert = `[${label}](https://example.com)`;
    let urlFrom = range.from + label.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlFrom, urlFrom + "https://example.com".length),
    };
  });
  view.dispatch({ ...transaction, scrollIntoView: true, userEvent: "input.markdownLink" });
  return true;
}

function toggleTaskOnCurrentLine(view: EditorView) {
  let line = view.state.doc.lineAt(view.state.selection.main.head);
  let task = readLineMarkers(view.state, line).task;
  if (!task) return false;
  view.dispatch({
    changes: {
      from: task.from + 1,
      to: task.from + 2,
      insert: task.checked ? " " : "x",
    },
    userEvent: "input.task",
  });
  return true;
}

function loadInitialDoc() {
  try {
    return window.localStorage.getItem(storageKey) || initialMarkdown;
  } catch {
    return initialMarkdown;
  }
}

function saveDoc(doc: string) {
  try {
    window.localStorage.setItem(storageKey, doc);
  } catch {
    // Local storage is optional for this demo.
  }
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

function applyTableAlignment(
  element: HTMLTableCellElement,
  alignment: "center" | "default" | "left" | "right" = "default",
) {
  if (alignment != "default") element.style.textAlign = alignment;
}
