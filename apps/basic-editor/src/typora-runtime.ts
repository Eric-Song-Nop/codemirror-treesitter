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
  HighlightStyle,
  syntaxTree,
  TreeSitterLanguage,
  type TreeSitterParser,
  highlightTree,
  tags,
  type SyntaxNode,
} from "@codemirror-treesitter/language";
import { languages } from "@codemirror-treesitter/language-data";
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

type MarkdownLineInfo = {
  classes: Set<string>;
  decorations: InlineDecoration[];
};

type MarkdownTableBlock = {
  firstLineNumber: number;
  from: number;
  lastLineNumber: number;
  lineNumbers: number[];
  table: MarkdownTable;
  to: number;
};

type MarkdownImageBlock = {
  alt: string;
  from: number;
  lineNumber: number;
  src: string;
  to: number;
};

type MarkdownAnalysis = {
  codeBlocks: CodeFenceBlock[];
  codeLines: Map<number, CodeLineState>;
  imageBlocks: Map<number, MarkdownImageBlock>;
  lines: Map<number, MarkdownLineInfo>;
  tableBlocks: MarkdownTableBlock[];
};

type CodeFenceBlock = {
  closingLine: number | null;
  contentFrom: number;
  contentTo: number;
  language: string;
  marker: "`" | "~";
  markerLength: number;
  openingLine: number;
};

type CodeLineState = {
  block: CodeFenceBlock;
  boundary: boolean;
  inside: boolean;
};

type CodeFenceLanguageMap = ReadonlyMap<string, TreeSitterParser>;

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

const codeFenceHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.definitionKeyword, tags.controlKeyword, tags.moduleKeyword],
    class: "cm-md-code-keyword",
  },
  {
    tag: [tags.string, tags.docString, tags.character, tags.attributeValue],
    class: "cm-md-code-string",
  },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom],
    class: "cm-md-code-number",
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    class: "cm-md-code-comment",
  },
  { tag: [tags.typeName, tags.tagName, tags.className], class: "cm-md-code-type" },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], class: "cm-md-code-property" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
    class: "cm-md-code-function",
  },
  { tag: [tags.operator, tags.punctuation, tags.bracket], class: "cm-md-code-punctuation" },
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3], class: "cm-md-code-heading" },
  { tag: [tags.strong], class: "cm-md-code-strong" },
  { tag: [tags.emphasis], class: "cm-md-code-emphasis" },
  { tag: [tags.link, tags.url], class: "cm-md-code-link" },
  { tag: [tags.monospace], class: "cm-md-code-monospace" },
]);

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

function buildTyporaDecorations(state: EditorState) {
  let builder = new RangeSetBuilder<Decoration>();
  let activeLines = getActiveLines(state);
  let analysis = analyzeMarkdownTree(state, activeLines);
  let codeHighlights = getCodeFenceHighlights(state, analysis.codeBlocks);
  let decoratedTables = new Set<number>();

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
    let line = state.doc.line(lineNumber);
    let active = activeLines.has(line.number);
    let lineInfo = analysis.lines.get(line.number);
    let decorations: InlineDecoration[] = [...(lineInfo?.decorations ?? [])];
    let classes = ["cm-md-line"];
    if (active) classes.push("cm-md-active-line");
    if (lineInfo) classes.push(...lineInfo.classes);

    let imageBlock = analysis.imageBlocks.get(line.number);
    if (imageBlock && !active) {
      builder.add(
        imageBlock.from,
        imageBlock.to,
        Decoration.replace({
          block: true,
          widget: new ImagePreviewWidget(imageBlock.alt, imageBlock.src),
        }),
      );
      continue;
    }

    let tableBlock = analysis.tableBlocks.find(
      (block) => block.firstLineNumber <= line.number && block.lastLineNumber >= line.number,
    );
    if (
      tableBlock &&
      !decoratedTables.has(tableBlock.firstLineNumber) &&
      !tableBlock.lineNumbers.some((tableLineNumber) => activeLines.has(tableLineNumber))
    ) {
      decoratedTables.add(tableBlock.firstLineNumber);
      builder.add(
        tableBlock.from,
        tableBlock.to,
        Decoration.replace({
          block: true,
          widget: new TablePreviewWidget(tableBlock.table, tableBlock.from),
        }),
      );
      lineNumber = tableBlock.lastLineNumber;
      continue;
    }

    decorations.push(...(codeHighlights.get(line.number) ?? []));

    builder.add(line.from, line.from, Decoration.line({ class: classes.join(" ") }));
    decorations
      .filter((decoration) => decoration.from < decoration.to)
      .sort((left, right) => left.from - right.from || left.to - right.to)
      .forEach(({ from: rangeFrom, to: rangeTo, decoration }) => {
        builder.add(rangeFrom, rangeTo, decoration);
      });
  }

  return builder.finish();
}

function addListMarker(
  decorations: InlineDecoration[],
  from: number,
  to: number,
  marker: string,
  active: boolean,
) {
  if (active) {
    addSyntax(decorations, from, to, active);
  } else {
    decorations.push({
      from,
      to,
      decoration: Decoration.replace({
        widget: new ListMarkerWidget(marker),
      }),
    });
  }
}

function addSyntax(decorations: InlineDecoration[], from: number, to: number, active: boolean) {
  decorations.push({ from, to, decoration: active ? visibleSyntax : hiddenSyntax });
}

function getActiveLines(state: EditorState) {
  let lines = new Set<number>();
  lines.add(state.doc.lineAt(state.selection.main.head).number);
  return lines;
}

function analyzeMarkdownTree(state: EditorState, activeLines: Set<number>): MarkdownAnalysis {
  let analysis: MarkdownAnalysis = {
    codeBlocks: [],
    codeLines: new Map(),
    imageBlocks: new Map(),
    lines: new Map(),
    tableBlocks: [],
  };

  syntaxTree(state).iterate({
    enter(node) {
      switch (node.name) {
        case "fenced_code_block":
          registerCodeFenceBlock(state, analysis, activeLines, node);
          return false;
        case "pipe_table":
          registerTableBlock(state, analysis, activeLines, node);
          return false;
        case "atx_heading":
          registerHeading(state, analysis, activeLines, node);
          return;
        case "setext_heading":
          registerSetextHeading(state, analysis, activeLines, node);
          return;
        case "block_quote":
          addLineClassForRange(state, analysis, node.from, node.to, "cm-md-blockquote");
          return;
        case "block_quote_marker":
        case "block_continuation":
          addSyntaxRange(state, analysis, activeLines, node.from, node.to);
          return;
        case "list_item":
          addLineClassForRange(state, analysis, node.from, node.to, "cm-md-list-line");
          return;
        case "list_marker_dot":
        case "list_marker_minus":
        case "list_marker_parenthesis":
        case "list_marker_plus":
        case "list_marker_star":
          registerListMarker(state, analysis, activeLines, node);
          return;
        case "task_list_marker_checked":
        case "task_list_marker_unchecked":
          registerTaskMarker(state, analysis, node);
          return;
        case "thematic_break":
          registerRule(state, analysis, activeLines, node);
          return false;
        case "strong_emphasis":
          addMarkRange(state, analysis, node.from, node.to, strongMark);
          return;
        case "emphasis":
          addMarkRange(state, analysis, node.from, node.to, emphasisMark);
          return;
        case "strikethrough":
          addMarkRange(state, analysis, node.from, node.to, strikeMark);
          return;
        case "code_span":
          addMarkRange(state, analysis, node.from, node.to, inlineCodeMark);
          return;
        case "emphasis_delimiter":
        case "code_span_delimiter":
          addSyntaxRange(state, analysis, activeLines, node.from, node.to);
          return;
        case "inline_link":
          registerInlineLink(state, analysis, activeLines, node);
          return;
        case "uri_autolink":
          registerUriAutolink(state, analysis, activeLines, node);
          return;
        case "image":
          registerImageNode(state, analysis, activeLines, node);
          return;
        default:
          return;
      }
    },
  });

  registerTyporaHighlightExtension(state, analysis, activeLines);
  return analysis;
}

function registerHeading(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
  node: SyntaxNode,
) {
  let marker = node.children.find((child) => child.name.startsWith("atx_h"));
  let level = marker ? Number(marker.name.at(5)) || 1 : 1;
  addLineClassForRange(state, analysis, node.from, node.to, "cm-md-heading");
  addLineClassForRange(state, analysis, node.from, node.to, `cm-md-heading-${level}`);
  if (marker) addSyntaxRange(state, analysis, activeLines, marker.from, marker.to);
}

function registerSetextHeading(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
  node: SyntaxNode,
) {
  let underline = node.children.find((child) => child.name.startsWith("setext_h"));
  let level = underline?.name == "setext_h2_underline" ? 2 : 1;
  addLineClassForRange(state, analysis, node.from, node.to, "cm-md-heading");
  addLineClassForRange(state, analysis, node.from, node.to, `cm-md-heading-${level}`);
  if (underline) addSyntaxRange(state, analysis, activeLines, underline.from, underline.to);
}

function registerListMarker(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
  node: SyntaxNode,
) {
  let line = state.doc.lineAt(node.from);
  let lineInfo = ensureLineInfo(analysis, line.number);
  lineInfo.classes.add("cm-md-list-line");
  addListMarker(
    lineInfo.decorations,
    node.from,
    node.to,
    state.sliceDoc(node.from, node.to).trim(),
    activeLines.has(line.number),
  );
}

function registerTaskMarker(state: EditorState, analysis: MarkdownAnalysis, node: SyntaxNode) {
  let line = state.doc.lineAt(node.from);
  let checked = node.name == "task_list_marker_checked";
  let lineInfo = ensureLineInfo(analysis, line.number);
  lineInfo.classes.add("cm-md-list-line");
  lineInfo.classes.add("cm-md-task-line");
  if (checked) lineInfo.classes.add("is-checked");
  lineInfo.decorations.push({
    from: node.from,
    to: node.to,
    decoration: Decoration.replace({
      widget: new TaskCheckboxWidget(checked, node.from),
    }),
  });
}

function registerRule(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
  node: SyntaxNode,
) {
  addLineClassForRange(state, analysis, node.from, node.to, "cm-md-rule-line");
  addSyntaxRange(state, analysis, activeLines, node.from, node.to);
}

function registerInlineLink(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
  node: SyntaxNode,
) {
  let text = node.getChild("link_text");
  if (!text) return;
  addSyntaxRange(state, analysis, activeLines, node.from, text.from);
  addMarkRange(state, analysis, text.from, text.to, linkMark);
  addSyntaxRange(state, analysis, activeLines, text.to, node.to);
}

function registerUriAutolink(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
  node: SyntaxNode,
) {
  if (node.to - node.from <= 2) return;
  addSyntaxRange(state, analysis, activeLines, node.from, node.from + 1);
  addMarkRange(state, analysis, node.from + 1, node.to - 1, linkMark);
  addSyntaxRange(state, analysis, activeLines, node.to - 1, node.to);
}

function registerImageNode(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
  node: SyntaxNode,
) {
  let description = node.getChild("image_description");
  let destination = node.getChild("link_destination");
  let alt = description ? state.sliceDoc(description.from, description.to) : "";
  let src = destination ? state.sliceDoc(destination.from, destination.to).trim() : "";
  if (!src) return;

  let line = state.doc.lineAt(node.from);
  if (isOnlyVisibleContentOnLine(state, line.from, line.to, node.from, node.to)) {
    analysis.imageBlocks.set(line.number, {
      alt,
      from: line.from,
      lineNumber: line.number,
      src: normalizeImageSource(src),
      to: line.to,
    });
    return;
  }

  if (!activeLines.has(line.number)) {
    ensureLineInfo(analysis, line.number).decorations.push({
      from: node.from,
      to: node.to,
      decoration: Decoration.replace({
        widget: new ImagePreviewWidget(alt, normalizeImageSource(src)),
      }),
    });
    return;
  }

  if (description) {
    addSyntaxRange(state, analysis, activeLines, node.from, description.from);
    addMarkRange(state, analysis, description.from, description.to, linkMark);
    addSyntaxRange(state, analysis, activeLines, description.to, node.to);
  }
}

function registerTableBlock(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
  node: SyntaxNode,
) {
  let headerNode = node.getChild("pipe_table_header");
  let delimiterNode = node.getChild("pipe_table_delimiter_row");
  if (!headerNode || !delimiterNode) return;

  addLineClassForRange(state, analysis, node.from, node.to, "cm-md-table-line");
  addLineClassForRange(
    state,
    analysis,
    delimiterNode.from,
    delimiterNode.to,
    "cm-md-table-divider",
  );
  forEachDescendant(node, (child) => {
    if (child.name == "|")
      addSyntaxRange(state, analysis, activeLines, child.from, child.to, tablePipeMark);
  });

  let header = tableCellsFromNode(state, headerNode, "pipe_table_cell");
  let alignments = tableAlignmentsFromNode(delimiterNode);
  if (header.length < 2 || alignments.length < 2) return;

  let columnCount = Math.max(header.length, alignments.length);
  let rows = node.children
    .filter((child) => child.name == "pipe_table_row")
    .map((row) =>
      normalizeTableCells(tableCellsFromNode(state, row, "pipe_table_cell"), columnCount),
    );
  let firstLineNumber = state.doc.lineAt(node.from).number;
  let lastLineNumber = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
  analysis.tableBlocks.push({
    firstLineNumber,
    from: node.from,
    lastLineNumber,
    lineNumbers: lineNumbersInRange(state, node.from, node.to),
    table: {
      alignments: normalizeTableAlignments(alignments, columnCount),
      header: normalizeTableCells(header, columnCount),
      rows,
    },
    to: node.to,
  });
}

function registerCodeFenceBlock(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
  node: SyntaxNode,
) {
  let delimiters = node.children.filter((child) => child.name == "fenced_code_block_delimiter");
  let openingDelimiter = delimiters[0];
  if (!openingDelimiter) return;

  let closingDelimiter = delimiters[1] ?? null;
  let infoString = node.getChild("info_string");
  let languageNode = infoString?.getChild("language") ?? infoString;
  let content = node.getChild("code_fence_content");
  let markerText = state.sliceDoc(openingDelimiter.from, openingDelimiter.to);
  let marker: "`" | "~" = markerText.startsWith("~") ? "~" : "`";
  let block: CodeFenceBlock = {
    closingLine: closingDelimiter ? state.doc.lineAt(closingDelimiter.from).number : null,
    contentFrom: content?.from ?? openingDelimiter.to,
    contentTo: content?.to ?? closingDelimiter?.from ?? node.to,
    language: languageNode
      ? normalizeFenceLanguage(state.sliceDoc(languageNode.from, languageNode.to))
      : "",
    marker,
    markerLength: markerText.length,
    openingLine: state.doc.lineAt(openingDelimiter.from).number,
  };

  analysis.codeBlocks.push(block);
  analysis.codeLines.set(block.openingLine, { block, boundary: true, inside: true });
  addLineClass(analysis, block.openingLine, "cm-md-code-fence-line");
  addSyntaxRange(state, analysis, activeLines, openingDelimiter.from, openingDelimiter.to);

  if (content && content.from < content.to) {
    for (let lineNumber of lineNumbersInRange(state, content.from, content.to)) {
      analysis.codeLines.set(lineNumber, { block, boundary: false, inside: true });
      addLineClass(analysis, lineNumber, "cm-md-code-line");
    }
  }

  if (closingDelimiter) {
    let closingLine = state.doc.lineAt(closingDelimiter.from).number;
    analysis.codeLines.set(closingLine, { block, boundary: true, inside: true });
    addLineClass(analysis, closingLine, "cm-md-code-fence-line");
    addSyntaxRange(state, analysis, activeLines, closingDelimiter.from, closingDelimiter.to);
  }
}

function registerTyporaHighlightExtension(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
) {
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name == "fenced_code_block") return false;
      if (node.name != "inline" || !node.parent) return;
      let parentName = node.parent.name;
      if (parentName != "paragraph" && parentName != "atx_heading") return;
      addTyporaHighlightRanges(state, analysis, activeLines, node.from, node.to);
    },
  });
}

function addTyporaHighlightRanges(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
  from: number,
  to: number,
) {
  let text = state.sliceDoc(from, to);
  let searchFrom = 0;
  while (searchFrom < text.length) {
    let open = text.indexOf("==", searchFrom);
    if (open < 0) return;
    let close = text.indexOf("==", open + 2);
    if (close < 0) return;
    addSyntaxRange(state, analysis, activeLines, from + open, from + open + 2);
    addMarkRange(state, analysis, from + open + 2, from + close, highlightMark);
    addSyntaxRange(state, analysis, activeLines, from + close, from + close + 2);
    searchFrom = close + 2;
  }
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

function lineNumbersInRange(state: EditorState, from: number, to: number) {
  let lines: number[] = [];
  if (from >= to) return lines;
  let line = state.doc.lineAt(from);
  let lastLine = state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber = line.number; lineNumber <= lastLine; lineNumber++) lines.push(lineNumber);
  return lines;
}

function addLineClassForRange(
  state: EditorState,
  analysis: MarkdownAnalysis,
  from: number,
  to: number,
  className: string,
) {
  for (let lineNumber of lineNumbersInRange(state, from, to))
    addLineClass(analysis, lineNumber, className);
}

function addLineClass(analysis: MarkdownAnalysis, lineNumber: number, className: string) {
  ensureLineInfo(analysis, lineNumber).classes.add(className);
}

function addSyntaxRange(
  state: EditorState,
  analysis: MarkdownAnalysis,
  activeLines: Set<number>,
  from: number,
  to: number,
  decoration?: Decoration,
) {
  addRangeDecoration(state, analysis, from, to, (lineNumber) => {
    if (decoration) return decoration;
    return activeLines.has(lineNumber) ? visibleSyntax : hiddenSyntax;
  });
}

function addMarkRange(
  state: EditorState,
  analysis: MarkdownAnalysis,
  from: number,
  to: number,
  decoration: Decoration,
) {
  addRangeDecoration(state, analysis, from, to, () => decoration);
}

function addRangeDecoration(
  state: EditorState,
  analysis: MarkdownAnalysis,
  from: number,
  to: number,
  decorationForLine: (lineNumber: number) => Decoration,
) {
  let cursor = from;
  while (cursor < to) {
    let line = state.doc.lineAt(cursor);
    let rangeTo = Math.min(to, line.to);
    if (cursor < rangeTo) {
      ensureLineInfo(analysis, line.number).decorations.push({
        from: cursor,
        to: rangeTo,
        decoration: decorationForLine(line.number),
      });
    }
    cursor = line.to < to ? line.to + 1 : to;
  }
}

function ensureLineInfo(analysis: MarkdownAnalysis, lineNumber: number) {
  let found = analysis.lines.get(lineNumber);
  if (!found) {
    found = { classes: new Set(), decorations: [] };
    analysis.lines.set(lineNumber, found);
  }
  return found;
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

function getCodeFenceHighlights(state: EditorState, blocks: CodeFenceBlock[]) {
  let highlights = new Map<number, InlineDecoration[]>();
  let languages = state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages;

  for (let block of blocks) {
    let parser = languages.get(block.language);
    if (!parser || block.contentFrom >= block.contentTo) continue;

    let source = state.sliceDoc(block.contentFrom, block.contentTo);
    let tree = parser.parse(Text.of(source.split("\n")));
    highlightTree(tree, codeFenceHighlightStyle, (from, to, className) => {
      addCodeHighlight(
        highlights,
        state,
        block.contentFrom + from,
        block.contentFrom + to,
        className,
      );
    });
  }

  return highlights;
}

function addCodeHighlight(
  highlights: Map<number, InlineDecoration[]>,
  state: EditorState,
  from: number,
  to: number,
  className: string,
) {
  if (from >= to) return;

  let cursor = from;
  while (cursor < to) {
    let line = state.doc.lineAt(cursor);
    let rangeTo = Math.min(to, line.to);
    if (cursor < rangeTo) {
      let decorations = highlights.get(line.number);
      if (!decorations) {
        decorations = [];
        highlights.set(line.number, decorations);
      }
      decorations.push({
        from: cursor,
        to: rangeTo,
        decoration: Decoration.mark({ class: className }),
      });
    }
    cursor = line.to < to ? line.to + 1 : to;
  }
}

function readLineMarkers(state: EditorState, line: { from: number; number: number; to: number }) {
  let result: {
    inCode: boolean;
    listMarker: { from: number; text: string; to: number } | null;
    quoteTo: number | null;
    task: { checked: boolean; from: number; to: number } | null;
  } = {
    inCode: false,
    listMarker: null,
    quoteTo: null,
    task: null,
  };

  let analysis = analyzeMarkdownTree(state, new Set([line.number]));
  result.inCode = analysis.codeLines.has(line.number);
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
