import "./style.css";
import {
  CompletionContext,
  autocompletion,
  type CompletionResult,
} from "@codemirror-treesitter/autocomplete";
import { EditorView, basicSetup } from "@codemirror-treesitter/basic-setup";
import { indentWithTab } from "@codemirror-treesitter/commands";
import { languages } from "@codemirror-treesitter/language-data";
import {
  HighlightStyle,
  NodeProp,
  bidiIsolates,
  ensureSyntaxTree,
  language as languageFacet,
  syntaxHighlighting,
  syntaxTree,
  syntaxTreeAvailable,
  tagHighlighter,
  tags,
  type LanguageSupport,
} from "@codemirror-treesitter/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import { Compartment, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

type SupportMap = Map<string, LanguageSupport>;
type Status = Record<string, string>;

type Example = {
  id: string;
  title: string;
  official: string;
  summary: string;
  doc: string;
  languageNames: readonly string[];
  selection?: number;
  extensions: (supports: SupportMap) => Extension[];
  inspect: (view: EditorView) => Status;
};

const languageCache = new Map<string, Promise<LanguageSupport>>();
let activeView: EditorView | null = null;
let activeExample: Example | null = null;
let statusTimer = 0;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<main class="app-shell">
  <aside class="sidebar">
    <div class="brand">
      <span class="mark">TS</span>
      <div>
        <p>CodeMirror Tree-sitter</p>
        <h1>Example Workbench</h1>
      </div>
    </div>
    <nav id="examples" class="example-list" aria-label="Examples"></nav>
  </aside>
  <section class="stage">
    <header class="stage-header">
      <div>
        <p id="example-source" class="source"></p>
        <h2 id="example-title"></h2>
      </div>
      <a id="official-link" class="official-link" target="_blank" rel="noreferrer">Official page</a>
    </header>
    <p id="example-summary" class="summary"></p>
    <div class="work-area">
      <div id="editor" class="editor-host"></div>
      <aside class="status-panel">
        <h3>Runtime Checks</h3>
        <dl id="status"></dl>
      </aside>
    </div>
  </section>
</main>
`;

const nav = document.querySelector<HTMLElement>("#examples")!;
const editorHost = document.querySelector<HTMLElement>("#editor")!;
const title = document.querySelector<HTMLElement>("#example-title")!;
const source = document.querySelector<HTMLElement>("#example-source")!;
const summary = document.querySelector<HTMLElement>("#example-summary")!;
const officialLink = document.querySelector<HTMLAnchorElement>("#official-link")!;
const statusList = document.querySelector<HTMLElement>("#status")!;

const examples: readonly Example[] = [
  {
    id: "basic",
    title: "Basic Editor",
    official: "https://codemirror.net/examples/basic/",
    summary: "basicSetup plus a TypeScript tree-sitter language loaded from language-data.",
    doc: `type Point = { x: number; y: number };

function distance(a: Point, b: Point) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}
`,
    languageNames: ["TypeScript"],
    extensions: (supports) => [support(supports, "TypeScript").extension],
    inspect: (view) => ({
      language: currentLanguageName(view),
      topNode: readyTree(view).topNode.name,
      parsed: String(syntaxTreeAvailable(view.state)),
    }),
  },
  {
    id: "configuration",
    title: "Configuration",
    official: "https://codemirror.net/examples/config/",
    summary: "Compartment-based language reconfiguration switches between HTML and TypeScript.",
    doc: `<main>
  <h1>Switchable configuration</h1>
  <script>const mode = "html";</script>
</main>
`,
    languageNames: ["HTML", "TypeScript"],
    extensions: (supports) => {
      let languageConfig = new Compartment();
      let html = support(supports, "HTML");
      let typeScript = support(supports, "TypeScript");
      return [
        languageConfig.of(html.extension),
        EditorState.transactionExtender.of((tr) => {
          if (!tr.docChanged) return null;
          let wantsHTML = /^\s*</.test(tr.newDoc.sliceString(0, Math.min(80, tr.newDoc.length)));
          let next = wantsHTML ? html : typeScript;
          return tr.startState.facet(languageFacet) == next.language
            ? null
            : { effects: languageConfig.reconfigure(next.extension) };
        }),
      ];
    },
    inspect: (view) => ({
      language: currentLanguageName(view),
      topNode: readyTree(view).topNode.name,
      modeRule: "leading < selects HTML",
    }),
  },
  {
    id: "language-package",
    title: "Writing a Language Package",
    official: "https://codemirror.net/examples/lang-package/",
    summary:
      "A tree-sitter language-data entry bundles parser, language data, and highlight query.",
    doc: `# Tree-sitter Markdown

This sample loads a language package with *block* and \`inline\` parsers.
`,
    languageNames: ["Markdown"],
    extensions: (supports) => [support(supports, "Markdown").extension],
    inspect: (view) => {
      let tree = readyTree(view);
      let emphasis = view.state.doc.toString().indexOf("block");
      return {
        language: currentLanguageName(view),
        topNode: tree.topNode.name,
        nestedParsers: String(tree.nested.length),
        nodeAtText: tree.resolveInner(emphasis).name,
      };
    },
  },
  {
    id: "mixed-language",
    title: "Mixed-Language Parsing",
    official: "https://codemirror.net/examples/mixed-language/",
    summary: "HTML delegates script/style ranges to JavaScript and CSS tree-sitter parsers.",
    doc: `<main>
  <style>
    main { display: grid; color: steelblue; }
  </style>
  <script>
    const message = "nested JavaScript";
    console.log(message.toUpperCase());
  </script>
</main>
`,
    languageNames: ["HTML"],
    extensions: (supports) => [support(supports, "HTML").extension],
    inspect: (view) => {
      let doc = view.state.doc.toString();
      let tree = readyTree(view);
      return {
        language: currentLanguageName(view),
        cssNode: tree.resolveInner(doc.indexOf("color")).name,
        jsNode: tree.resolveInner(doc.indexOf("message =")).name,
        nestedParsers: String(tree.nested.length),
      };
    },
  },
  {
    id: "bidi",
    title: "Right-to-left Text",
    official: "https://codemirror.net/examples/bidi/",
    summary:
      "HTML tag nodes expose bidi isolate metadata, and bidiIsolates turns it into editor decorations.",
    doc: `النص <span class="blue">الأزرق</span>
`,
    languageNames: ["HTML"],
    extensions: (supports) => [
      support(supports, "HTML").extension,
      bidiIsolates({ alwaysIsolate: true }),
      EditorView.theme({ "&": { direction: "rtl" } }),
    ],
    inspect: (view) => ({
      language: currentLanguageName(view),
      topNode: readyTree(view).topNode.name,
      isolatedTags: String(countIsolatedNodes(view)),
    }),
  },
  {
    id: "decoration",
    title: "Decoration",
    official: "https://codemirror.net/examples/decoration/",
    summary: "A ViewPlugin scans the syntax tree and replaces boolean literal ranges.",
    doc: `{
  "enabled": true,
  "archived": false,
  "nested": { "visible": true }
}
`,
    languageNames: ["JSON"],
    extensions: (supports) => [support(supports, "JSON").extension, booleanDecorations],
    inspect: (view) => ({
      language: currentLanguageName(view),
      topNode: readyTree(view).topNode.name,
      booleanWidgets: String(countText(view, /true|false/g)),
    }),
  },
  {
    id: "autocompletion",
    title: "Autocompletion",
    official: "https://codemirror.net/examples/autocompletion/",
    summary: "A completion source uses the tree-sitter syntax tree to limit JSDoc tag suggestions.",
    doc: `/**
 * Send a request.
 * @pa
 */
function request(url: string) {
  return fetch(url);
}
`,
    languageNames: ["TypeScript"],
    selection: 29,
    extensions: (supports) => [
      support(supports, "TypeScript").extension,
      autocompletion({ override: [jsDocCompletions] }),
    ],
    inspect: (view) => {
      let result = jsDocCompletions(
        new CompletionContext(view.state, view.state.selection.main.head, true),
      );
      return {
        language: currentLanguageName(view),
        cursorNode: syntaxTree(view.state).resolveInner(view.state.selection.main.head, -1).name,
        suggestions: result ? result.options.map((option) => option.label).join(", ") : "none",
      };
    },
  },
  {
    id: "lint",
    title: "Linting",
    official: "https://codemirror.net/examples/lint/",
    summary: "A linter walks the tree-sitter syntax tree to reject regular expression literals.",
    doc: `const words = /\\w+/g;
const plain = "use a string instead";
`,
    languageNames: ["JavaScript"],
    extensions: (supports) => [
      support(supports, "JavaScript").extension,
      linter((view) => regexpDiagnostics(view.state)),
    ],
    inspect: (view) => ({
      language: currentLanguageName(view),
      topNode: readyTree(view).topNode.name,
      diagnostics: String(regexpDiagnostics(view.state).length),
    }),
  },
  {
    id: "styling",
    title: "Styling",
    official: "https://codemirror.net/examples/styling/",
    summary: "HighlightStyle and syntaxHighlighting consume tree-sitter query tags.",
    doc: `# Styled Markdown

Strong **text**, emphasized *text*, and \`code\`.
`,
    languageNames: ["Markdown"],
    extensions: (supports) => [
      support(supports, "Markdown").extension,
      syntaxHighlighting(exampleHighlightStyle),
    ],
    inspect: (view) => {
      let spans = highlightProbe(view);
      return {
        language: currentLanguageName(view),
        headingSpans: String(spans.heading),
        emphasisSpans: String(spans.emphasis),
      };
    },
  },
  {
    id: "tab",
    title: "Handling Tab",
    official: "https://codemirror.net/examples/tab/",
    summary:
      "The local commands package provides an indentWithTab key binding for tree-sitter indentation.",
    doc: `function tabHandled() {
console.log("Press Tab at the start of this line.");
}
`,
    languageNames: ["JavaScript"],
    extensions: (supports) => [
      support(supports, "JavaScript").extension,
      keymap.of([indentWithTab]),
    ],
    inspect: (view) => ({
      language: currentLanguageName(view),
      indentUnit: view.state.facet(EditorState.tabSize).toString(),
      topNode: readyTree(view).topNode.name,
    }),
  },
  {
    id: "huge-document",
    title: "Huge Document",
    official: "https://codemirror.net/examples/million/",
    summary: "A large document exercises parser scheduling, time budgets, and resumable parsing.",
    doc: makeLargeDocument(),
    languageNames: ["JavaScript"],
    extensions: (supports) => [support(supports, "JavaScript").extension],
    inspect: (view) => {
      let tree = ensureSyntaxTree(view.state, view.state.doc.length, 100);
      return {
        language: currentLanguageName(view),
        lines: String(view.state.doc.lines),
        treeAvailable: String(Boolean(tree) || syntaxTreeAvailable(view.state)),
      };
    },
  },
];

for (let example of examples) {
  let button = document.createElement("button");
  button.type = "button";
  button.textContent = example.title;
  button.dataset.example = example.id;
  button.addEventListener("click", () => void showExample(example.id));
  nav.append(button);
}

void showExample(location.hash.slice(1) || examples[0]!.id);
window.addEventListener(
  "hashchange",
  () => void showExample(location.hash.slice(1) || examples[0]!.id),
);

async function showExample(id: string) {
  let example = examples.find((example) => example.id == id) ?? examples[0]!;
  activeExample = example;
  location.hash = example.id;
  for (let button of nav.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.example == example.id);
  }
  title.textContent = example.title;
  source.textContent = example.official.replace("https://codemirror.net/examples/", "examples/");
  summary.textContent = example.summary;
  officialLink.href = example.official;
  statusList.innerHTML = "<div><dt>Status</dt><dd>Loading grammars</dd></div>";

  let supports = await loadSupports(example.languageNames);
  if (activeExample != example) return;
  activeView?.destroy();
  activeView = new EditorView({
    parent: editorHost,
    state: EditorState.create({
      doc: example.doc,
      selection: example.selection ? { anchor: example.selection } : undefined,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        example.extensions(supports),
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.selectionSet || update.viewportChanged) queueStatus();
        }),
      ],
    }),
  });
  queueStatus();
}

async function loadSupports(names: readonly string[]) {
  let supports = new Map<string, LanguageSupport>();
  await Promise.all(
    names.map(async (name) => {
      supports.set(name, await loadSupport(name));
    }),
  );
  return supports;
}

function loadSupport(name: string) {
  let found = languageCache.get(name);
  if (found) return found;
  let description = languages.find((language) => language.name == name);
  if (!description) throw new RangeError(`Missing language-data entry for ${name}`);
  let loaded = description.load();
  languageCache.set(name, loaded);
  return loaded;
}

function support(supports: SupportMap, name: string) {
  let found = supports.get(name);
  if (!found) throw new RangeError(`Language ${name} was not loaded`);
  return found;
}

function queueStatus() {
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(renderStatus, 30);
}

function renderStatus() {
  if (!activeView || !activeExample) return;
  let status: Status;
  try {
    status = activeExample.inspect(activeView);
  } catch (error) {
    status = { error: error instanceof Error ? error.message : String(error) };
  }
  statusList.replaceChildren(
    ...Object.entries(status).map(([label, value]) => {
      let row = document.createElement("div");
      let key = document.createElement("dt");
      let val = document.createElement("dd");
      key.textContent = label;
      val.textContent = value;
      row.append(key, val);
      return row;
    }),
  );
}

function readyTree(view: EditorView) {
  ensureSyntaxTree(view.state, view.state.doc.length, 25);
  return syntaxTree(view.state);
}

function currentLanguageName(view: EditorView) {
  return view.state.facet(languageFacet)?.name ?? "none";
}

function countIsolatedNodes(view: EditorView) {
  let count = 0;
  readyTree(view).iterate({
    enter(node) {
      if (node.type.prop(NodeProp.isolate)) count++;
    },
  });
  return count;
}

class BooleanWidget extends WidgetType {
  readonly value: string;

  constructor(value: string) {
    super();
    this.value = value;
  }

  eq(other: BooleanWidget) {
    return other.value == this.value;
  }

  toDOM() {
    let span = document.createElement("span");
    span.className = `bool-widget ${this.value}`;
    span.textContent = this.value;
    return span;
  }
}

const booleanDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) != syntaxTree(update.state)
      ) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView) {
      let builder = new RangeSetBuilder<Decoration>();
      let tree = syntaxTree(view.state);
      for (let range of view.visibleRanges) {
        tree.iterate({
          from: range.from,
          to: range.to,
          enter(node) {
            if ((node.name == "true" || node.name == "false") && node.from < node.to) {
              builder.add(
                node.from,
                node.to,
                Decoration.replace({ widget: new BooleanWidget(node.name) }),
              );
            }
          },
        });
      }
      return builder.finish();
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

function jsDocCompletions(context: CompletionContext): CompletionResult | null {
  let token = context.matchBefore(/@\w*/);
  if (!token) return null;
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  if (node.name != "comment") return null;
  return {
    from: token.from,
    options: [
      { label: "@param", type: "keyword", detail: "document a parameter" },
      { label: "@returns", type: "keyword", detail: "document a return value" },
      { label: "@throws", type: "keyword", detail: "document an exception" },
    ],
    validFor: /^@\w*$/,
  };
}

function regexpDiagnostics(state: EditorState): Diagnostic[] {
  let diagnostics: Diagnostic[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name == "regex" || node.name == "regex_pattern") {
        diagnostics.push({
          from: node.from,
          to: node.to,
          severity: "warning",
          message: "Regular expression literal found by tree-sitter syntax traversal",
        });
      }
    },
  });
  return diagnostics;
}

const exampleHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, class: "cmx-heading" },
  { tag: tags.strong, class: "cmx-strong" },
  { tag: tags.emphasis, class: "cmx-emphasis" },
  { tag: tags.monospace, class: "cmx-code" },
]);

const probeHighlighter = tagHighlighter([
  { tag: tags.heading, class: "heading" },
  { tag: tags.emphasis, class: "emphasis" },
]);

function highlightProbe(view: EditorView) {
  let counts = { heading: 0, emphasis: 0 };
  let tree = syntaxTree(view.state);
  let tagsByTree = tree.config?.highlightTags?.(tree, 0, view.state.doc.length);
  if (tagsByTree) {
    for (let tags of tagsByTree.values()) {
      let cls = probeHighlighter.style(tags);
      if (cls?.includes("heading")) counts.heading++;
      if (cls?.includes("emphasis")) counts.emphasis++;
    }
  }
  for (let nested of tree.nested) {
    let nestedTags = nested.tree.config?.highlightTags?.(nested.tree, 0, view.state.doc.length);
    if (!nestedTags) continue;
    for (let tags of nestedTags.values()) {
      let cls = probeHighlighter.style(tags);
      if (cls?.includes("heading")) counts.heading++;
      if (cls?.includes("emphasis")) counts.emphasis++;
    }
  }
  return counts;
}

function countText(view: EditorView, pattern: RegExp) {
  return Array.from(view.state.doc.toString().matchAll(pattern)).length;
}

function makeLargeDocument() {
  let lines: string[] = [];
  for (let i = 0; i < 4000; i++) {
    lines.push(`const value${i} = ${i};`);
  }
  lines.push("export const total = value1 + value3999;");
  return `${lines.join("\n")}\n`;
}
