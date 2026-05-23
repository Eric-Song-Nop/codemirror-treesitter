import "./style.css";
import {
  CompletionContext as TreeCompletionContext,
  autocompletion as treeAutocompletion,
  type CompletionResult as TreeCompletionResult,
} from "@codemirror-treesitter/autocomplete";
import { basicSetup as treeBasicSetup } from "@codemirror-treesitter/basic-setup";
import { indentWithTab as treeIndentWithTab } from "@codemirror-treesitter/commands";
import { languages as treeLanguages } from "@codemirror-treesitter/language-data";
import {
  HighlightStyle as TreeHighlightStyle,
  NodeProp as TreeNodeProp,
  bidiIsolates as treeBidiIsolates,
  ensureSyntaxTree as treeEnsureSyntaxTree,
  language as treeLanguageFacet,
  syntaxHighlighting as treeSyntaxHighlighting,
  syntaxTree as treeSyntaxTree,
  syntaxTreeAvailable as treeSyntaxTreeAvailable,
  tags as treeTags,
  type LanguageSupport as TreeLanguageSupport,
} from "@codemirror-treesitter/language";
import {
  CompletionContext as LezerCompletionContext,
  autocompletion as lezerAutocompletion,
  type CompletionResult as LezerCompletionResult,
} from "@codemirror/autocomplete";
import { indentWithTab as lezerIndentWithTab } from "@codemirror/commands";
import { languages as lezerLanguages } from "@codemirror/language-data";
import {
  HighlightStyle as LezerHighlightStyle,
  bidiIsolates as lezerBidiIsolates,
  ensureSyntaxTree as lezerEnsureSyntaxTree,
  language as lezerLanguageFacet,
  syntaxHighlighting as lezerSyntaxHighlighting,
  syntaxTree as lezerSyntaxTree,
  syntaxTreeAvailable as lezerSyntaxTreeAvailable,
  type LanguageSupport as LezerLanguageSupport,
} from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import { Compartment, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as lezerTags } from "@lezer/highlight";
import { NodeProp as LezerNodeProp } from "@lezer/common";
import { basicSetup as lezerBasicSetup } from "codemirror";

type EngineId = "tree" | "lezer";
type Status = Record<string, string>;
type SupportMap<Support> = Map<string, Support>;
type LoadSupport<Support> = (name: string) => Promise<Support>;

type Runtime<Support> = {
  languageNames: readonly string[];
  extensions: (supports: SupportMap<Support>) => Extension[];
  inspect: (view: EditorView) => Status;
};

type CompareRow = {
  label: string;
  pass: boolean;
  detail: string;
};

type Example = {
  id: string;
  title: string;
  official: string;
  summary: string;
  doc: string;
  selection?: number;
  tree: Runtime<TreeLanguageSupport>;
  lezer: Runtime<LezerLanguageSupport>;
  compare: (tree: Status, lezer: Status) => CompareRow[];
};

type EngineState<Support> = {
  id: EngineId;
  label: string;
  source: string;
  loadSupport: LoadSupport<Support>;
  view: EditorView | null;
  status: Status;
  editor: HTMLElement;
  statusList: HTMLElement;
};

const treeLanguageCache = new Map<string, Promise<TreeLanguageSupport>>();
const lezerLanguageCache = new Map<string, Promise<LezerLanguageSupport>>();

let activeExample: Example | null = null;
let activeRun = 0;
let statusTimer = 0;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<main class="app-shell">
  <aside class="sidebar">
    <div class="brand">
      <span class="mark">CM</span>
      <div>
        <p>Tree-sitter vs Lezer</p>
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
      <section class="engine-card" data-engine="tree">
        <header>
          <div>
            <p>Local implementation</p>
            <h3>Tree-sitter</h3>
          </div>
          <span class="engine-badge">TS</span>
        </header>
        <div id="tree-editor" class="editor-host"></div>
        <dl id="tree-status" class="status-list" data-engine="tree"></dl>
      </section>
      <section class="engine-card" data-engine="lezer">
        <header>
          <div>
            <p>Original implementation</p>
            <h3>CodeMirror + Lezer</h3>
          </div>
          <span class="engine-badge">LZ</span>
        </header>
        <div id="lezer-editor" class="editor-host"></div>
        <dl id="lezer-status" class="status-list" data-engine="lezer"></dl>
      </section>
      <aside class="comparison-panel">
        <h3>Behavior Comparison</h3>
        <dl id="comparison-status" class="status-list comparison-list"></dl>
      </aside>
    </div>
  </section>
</main>
`;

const nav = document.querySelector<HTMLElement>("#examples")!;
const title = document.querySelector<HTMLElement>("#example-title")!;
const source = document.querySelector<HTMLElement>("#example-source")!;
const summary = document.querySelector<HTMLElement>("#example-summary")!;
const officialLink = document.querySelector<HTMLAnchorElement>("#official-link")!;
const comparisonList = document.querySelector<HTMLElement>("#comparison-status")!;

const treeEngine: EngineState<TreeLanguageSupport> = {
  id: "tree",
  label: "Tree-sitter",
  source: "local @codemirror-treesitter packages",
  loadSupport: loadTreeSupport,
  view: null,
  status: { status: "idle" },
  editor: document.querySelector<HTMLElement>("#tree-editor")!,
  statusList: document.querySelector<HTMLElement>("#tree-status")!,
};

const lezerEngine: EngineState<LezerLanguageSupport> = {
  id: "lezer",
  label: "CodeMirror + Lezer",
  source: "official @codemirror packages",
  loadSupport: loadLezerSupport,
  view: null,
  status: { status: "idle" },
  editor: document.querySelector<HTMLElement>("#lezer-editor")!,
  statusList: document.querySelector<HTMLElement>("#lezer-status")!,
};

const engines = {
  tree: treeEngine,
  lezer: lezerEngine,
};

const examples: readonly Example[] = [
  {
    id: "basic",
    title: "Basic Editor",
    official: "https://codemirror.net/examples/basic/",
    summary:
      "The same TypeScript document is loaded with local Tree-sitter packages and official Lezer packages.",
    doc: `type Point = { x: number; y: number };

function distance(a: Point, b: Point) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}
`,
    tree: {
      languageNames: ["TypeScript"],
      extensions: (supports) => [treeSupport(supports, "TypeScript").extension],
      inspect: (view) => ({
        language: treeCurrentLanguageName(view),
        topNode: treeReadyTree(view).topNode.name,
        parsed: String(treeSyntaxTreeAvailable(view.state)),
      }),
    },
    lezer: {
      languageNames: ["TypeScript"],
      extensions: (supports) => [lezerSupport(supports, "TypeScript").extension],
      inspect: (view) => ({
        language: lezerCurrentLanguageName(view),
        topNode: lezerReadyTree(view).topNode.name,
        parsed: String(lezerSyntaxTreeAvailable(view.state)),
      }),
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "typescript"),
      truthyCheck("parser ready", tree.parsed == "true" && lezer.parsed == "true", tree, lezer),
      presentCheck("top node", tree.topNode, lezer.topNode),
    ],
  },
  {
    id: "configuration",
    title: "Configuration",
    official: "https://codemirror.net/examples/config/",
    summary: "Both implementations use a Compartment to choose HTML for documents starting with <.",
    doc: `<main>
  <h1>Switchable configuration</h1>
  <script>const mode = "html";</script>
</main>
`,
    tree: {
      languageNames: ["HTML", "TypeScript"],
      extensions: (supports) => {
        let languageConfig = new Compartment();
        let html = treeSupport(supports, "HTML");
        let typeScript = treeSupport(supports, "TypeScript");
        return [
          languageConfig.of(html.extension),
          EditorState.transactionExtender.of((tr) => {
            if (!tr.docChanged) return null;
            let wantsHTML = /^\s*</.test(tr.newDoc.sliceString(0, Math.min(80, tr.newDoc.length)));
            let next = wantsHTML ? html : typeScript;
            return tr.startState.facet(treeLanguageFacet) == next.language
              ? null
              : { effects: languageConfig.reconfigure(next.extension) };
          }),
        ];
      },
      inspect: (view) => ({
        language: treeCurrentLanguageName(view),
        topNode: treeReadyTree(view).topNode.name,
        modeRule: "leading < selects HTML",
      }),
    },
    lezer: {
      languageNames: ["HTML", "TypeScript"],
      extensions: (supports) => {
        let languageConfig = new Compartment();
        let html = lezerSupport(supports, "HTML");
        let typeScript = lezerSupport(supports, "TypeScript");
        return [
          languageConfig.of(html.extension),
          EditorState.transactionExtender.of((tr) => {
            if (!tr.docChanged) return null;
            let wantsHTML = /^\s*</.test(tr.newDoc.sliceString(0, Math.min(80, tr.newDoc.length)));
            let next = wantsHTML ? html : typeScript;
            return tr.startState.facet(lezerLanguageFacet) == next.language
              ? null
              : { effects: languageConfig.reconfigure(next.extension) };
          }),
        ];
      },
      inspect: (view) => ({
        language: lezerCurrentLanguageName(view),
        topNode: lezerReadyTree(view).topNode.name,
        modeRule: "leading < selects HTML",
      }),
    },
    compare: (tree, lezer) => [
      equalityCheck("configured language", tree.language, lezer.language, "html"),
      equalityCheck("mode rule", tree.modeRule, lezer.modeRule, "leading < selects HTML"),
      presentCheck("configured parser", tree.topNode, lezer.topNode),
    ],
  },
  {
    id: "language-package",
    title: "Writing a Language Package",
    official: "https://codemirror.net/examples/lang-package/",
    summary:
      "Markdown loads as a language package in both runtimes; inline emphasis is parsed by each parser stack.",
    doc: `# Tree-sitter Markdown

This sample loads a language package with *block* and \`inline\` parsers.
`,
    tree: {
      languageNames: ["Markdown"],
      extensions: (supports) => [treeSupport(supports, "Markdown").extension],
      inspect: (view) => {
        let tree = treeReadyTree(view);
        let emphasis = view.state.doc.toString().indexOf("block");
        return {
          language: treeCurrentLanguageName(view),
          topNode: tree.topNode.name,
          nestedParsers: String(tree.nested.length),
          nodeAtText: tree.resolveInner(emphasis).name,
        };
      },
    },
    lezer: {
      languageNames: ["Markdown"],
      extensions: (supports) => [lezerSupport(supports, "Markdown").extension],
      inspect: (view) => {
        let tree = lezerReadyTree(view);
        let emphasis = view.state.doc.toString().indexOf("block");
        return {
          language: lezerCurrentLanguageName(view),
          topNode: tree.topNode.name,
          inlineParser: "Lezer markdown inline parser",
          nodeAtText: tree.resolveInner(emphasis).name,
        };
      },
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "markdown"),
      semanticNodeCheck("inline emphasis", tree.nodeAtText, lezer.nodeAtText, [
        "emphasis",
        "Emphasis",
      ]),
      presentCheck("document tree", tree.topNode, lezer.topNode),
    ],
  },
  {
    id: "mixed-language",
    title: "Mixed-Language Parsing",
    official: "https://codemirror.net/examples/mixed-language/",
    summary:
      "HTML delegates style and script ranges to nested CSS and JavaScript parsers in both runtimes.",
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
    tree: {
      languageNames: ["HTML"],
      extensions: (supports) => [treeSupport(supports, "HTML").extension],
      inspect: (view) => {
        let doc = view.state.doc.toString();
        let tree = treeReadyTree(view);
        return {
          language: treeCurrentLanguageName(view),
          cssNode: tree.resolveInner(doc.indexOf("color")).name,
          jsNode: tree.resolveInner(doc.indexOf("message =")).name,
          nestedParsers: String(tree.nested.length),
        };
      },
    },
    lezer: {
      languageNames: ["HTML"],
      extensions: (supports) => [lezerSupport(supports, "HTML").extension],
      inspect: (view) => {
        let doc = view.state.doc.toString();
        let tree = lezerReadyTree(view);
        return {
          language: lezerCurrentLanguageName(view),
          cssNode: tree.resolveInner(doc.indexOf("color")).name,
          jsNode: tree.resolveInner(doc.indexOf("message =")).name,
          nestedParsers: "CSS and JavaScript mounted parsers",
        };
      },
    },
    compare: (tree, lezer) => [
      equalityCheck("host language", tree.language, lezer.language, "html"),
      semanticNodeCheck("CSS range parsed", tree.cssNode, lezer.cssNode, [
        "property_name",
        "PropertyName",
        "Block",
      ]),
      semanticNodeCheck("JavaScript range parsed", tree.jsNode, lezer.jsNode, [
        "identifier",
        "VariableDefinition",
        "VariableDeclaration",
      ]),
      truthyCheck(
        "nested languages",
        Number(tree.nestedParsers) >= 2 && lezer.nestedParsers.includes("mounted"),
        tree,
        lezer,
      ),
    ],
  },
  {
    id: "bidi",
    title: "Right-to-left Text",
    official: "https://codemirror.net/examples/bidi/",
    summary: "HTML nodes expose bidi isolate metadata, and bidiIsolates turns it into decorations.",
    doc: `النص <span class="blue">الأزرق</span>
`,
    tree: {
      languageNames: ["HTML"],
      extensions: (supports) => [
        treeSupport(supports, "HTML").extension,
        treeBidiIsolates({ alwaysIsolate: true }),
        EditorView.theme({ "&": { direction: "rtl" } }),
      ],
      inspect: (view) => ({
        language: treeCurrentLanguageName(view),
        topNode: treeReadyTree(view).topNode.name,
        isolatedTags: String(treeCountIsolatedNodes(view)),
      }),
    },
    lezer: {
      languageNames: ["HTML"],
      extensions: (supports) => [
        lezerSupport(supports, "HTML").extension,
        lezerBidiIsolates({ alwaysIsolate: true }),
        EditorView.theme({ "&": { direction: "rtl" } }),
      ],
      inspect: (view) => ({
        language: lezerCurrentLanguageName(view),
        topNode: lezerReadyTree(view).topNode.name,
        isolatedTags: String(lezerCountIsolatedNodes(view)),
      }),
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "html"),
      truthyCheck(
        "isolate metadata",
        Number(tree.isolatedTags) > 0 && Number(lezer.isolatedTags) > 0,
        tree,
        lezer,
      ),
      presentCheck("HTML tree", tree.topNode, lezer.topNode),
    ],
  },
  {
    id: "decoration",
    title: "Decoration",
    official: "https://codemirror.net/examples/decoration/",
    summary: "Each runtime scans its syntax tree and replaces JSON boolean literals with widgets.",
    doc: `{
  "enabled": true,
  "archived": false,
  "nested": { "visible": true }
}
`,
    tree: {
      languageNames: ["JSON"],
      extensions: (supports) => [
        treeSupport(supports, "JSON").extension,
        booleanDecorations(treeSyntaxTree, ["true", "false"]),
      ],
      inspect: (view) => ({
        language: treeCurrentLanguageName(view),
        topNode: treeReadyTree(view).topNode.name,
        booleanWidgets: String(countBooleanWidgets(view)),
      }),
    },
    lezer: {
      languageNames: ["JSON"],
      extensions: (supports) => [
        lezerSupport(supports, "JSON").extension,
        booleanDecorations(lezerSyntaxTree, ["True", "False"]),
      ],
      inspect: (view) => ({
        language: lezerCurrentLanguageName(view),
        topNode: lezerReadyTree(view).topNode.name,
        booleanWidgets: String(countBooleanWidgets(view)),
      }),
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "json"),
      equalityCheck("boolean widgets", tree.booleanWidgets, lezer.booleanWidgets, "3"),
      presentCheck("JSON tree", tree.topNode, lezer.topNode),
    ],
  },
  {
    id: "autocompletion",
    title: "Autocompletion",
    official: "https://codemirror.net/examples/autocompletion/",
    summary: "Both completion sources use the active syntax tree to limit JSDoc tag suggestions.",
    doc: `/**
 * Send a request.
 * @pa
 */
function request(url: string) {
  return fetch(url);
}
`,
    selection: 29,
    tree: {
      languageNames: ["TypeScript"],
      extensions: (supports) => [
        treeSupport(supports, "TypeScript").extension,
        treeAutocompletion({ override: [treeJsDocCompletions] }),
      ],
      inspect: (view) => {
        let result = treeJsDocCompletions(
          new TreeCompletionContext(view.state, view.state.selection.main.head, true),
        );
        return {
          language: treeCurrentLanguageName(view),
          cursorNode: treeSyntaxTree(view.state).resolveInner(view.state.selection.main.head, -1)
            .name,
          suggestions: result ? result.options.map((option) => option.label).join(", ") : "none",
        };
      },
    },
    lezer: {
      languageNames: ["TypeScript"],
      extensions: (supports) => [
        lezerSupport(supports, "TypeScript").extension,
        lezerAutocompletion({ override: [lezerJsDocCompletions] }),
      ],
      inspect: (view) => {
        let result = lezerJsDocCompletions(
          new LezerCompletionContext(view.state, view.state.selection.main.head, true),
        );
        return {
          language: lezerCurrentLanguageName(view),
          cursorNode: lezerSyntaxTree(view.state).resolveInner(view.state.selection.main.head, -1)
            .name,
          suggestions: result ? result.options.map((option) => option.label).join(", ") : "none",
        };
      },
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "typescript"),
      equalityCheck("JSDoc suggestions", tree.suggestions, lezer.suggestions),
      semanticNodeCheck("comment context", tree.cursorNode, lezer.cursorNode, [
        "comment",
        "BlockComment",
      ]),
    ],
  },
  {
    id: "lint",
    title: "Linting",
    official: "https://codemirror.net/examples/lint/",
    summary: "The same linter rule walks each syntax tree to reject regular expression literals.",
    doc: `const words = /\\w+/g;
const plain = "use a string instead";
`,
    tree: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [
        treeSupport(supports, "JavaScript").extension,
        linter((view) => regexpDiagnostics(view.state, treeSyntaxTree, ["regex"])),
      ],
      inspect: (view) => ({
        language: treeCurrentLanguageName(view),
        topNode: treeReadyTree(view).topNode.name,
        diagnostics: String(regexpDiagnostics(view.state, treeSyntaxTree, ["regex"]).length),
      }),
    },
    lezer: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [
        lezerSupport(supports, "JavaScript").extension,
        linter((view) => regexpDiagnostics(view.state, lezerSyntaxTree, ["RegExp"])),
      ],
      inspect: (view) => ({
        language: lezerCurrentLanguageName(view),
        topNode: lezerReadyTree(view).topNode.name,
        diagnostics: String(regexpDiagnostics(view.state, lezerSyntaxTree, ["RegExp"]).length),
      }),
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "javascript"),
      equalityCheck("regex diagnostics", tree.diagnostics, lezer.diagnostics, "1"),
      presentCheck("JavaScript tree", tree.topNode, lezer.topNode),
    ],
  },
  {
    id: "styling",
    title: "Styling",
    official: "https://codemirror.net/examples/styling/",
    summary: "HighlightStyle and syntaxHighlighting render equivalent Markdown emphasis classes.",
    doc: `# Styled Markdown

Strong **text**, emphasized *text*, and \`code\`.
`,
    tree: {
      languageNames: ["Markdown"],
      extensions: (supports) => [
        treeSupport(supports, "Markdown").extension,
        treeSyntaxHighlighting(treeExampleHighlightStyle),
      ],
      inspect: (view) => {
        let spans = highlightProbe(view);
        return {
          language: treeCurrentLanguageName(view),
          headingSpans: String(spans.heading),
          emphasisSpans: String(spans.emphasis),
        };
      },
    },
    lezer: {
      languageNames: ["Markdown"],
      extensions: (supports) => [
        lezerSupport(supports, "Markdown").extension,
        lezerSyntaxHighlighting(lezerExampleHighlightStyle),
      ],
      inspect: (view) => {
        let spans = highlightProbe(view);
        return {
          language: lezerCurrentLanguageName(view),
          headingSpans: String(spans.heading),
          emphasisSpans: String(spans.emphasis),
        };
      },
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "markdown"),
      truthyCheck(
        "heading highlight",
        Number(tree.headingSpans) > 0 && Number(lezer.headingSpans) > 0,
        tree,
        lezer,
      ),
      truthyCheck(
        "emphasis highlight",
        Number(tree.emphasisSpans) > 0 && Number(lezer.emphasisSpans) > 0,
        tree,
        lezer,
      ),
    ],
  },
  {
    id: "tab",
    title: "Handling Tab",
    official: "https://codemirror.net/examples/tab/",
    summary: "The Tab key binding uses each runtime's indentation behavior.",
    doc: `function tabHandled() {
console.log("Press Tab at the start of this line.");
}
`,
    tree: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [
        treeSupport(supports, "JavaScript").extension,
        keymap.of([treeIndentWithTab]),
      ],
      inspect: (view) => ({
        language: treeCurrentLanguageName(view),
        indentUnit: view.state.facet(EditorState.tabSize).toString(),
        topNode: treeReadyTree(view).topNode.name,
      }),
    },
    lezer: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [
        lezerSupport(supports, "JavaScript").extension,
        keymap.of([lezerIndentWithTab]),
      ],
      inspect: (view) => ({
        language: lezerCurrentLanguageName(view),
        indentUnit: view.state.facet(EditorState.tabSize).toString(),
        topNode: lezerReadyTree(view).topNode.name,
      }),
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "javascript"),
      equalityCheck("tab size", tree.indentUnit, lezer.indentUnit, "4"),
      presentCheck("JavaScript tree", tree.topNode, lezer.topNode),
    ],
  },
  {
    id: "huge-document",
    title: "Huge Document",
    official: "https://codemirror.net/examples/million/",
    summary: "Large-document parsing reaches an available syntax tree in both parser runtimes.",
    doc: makeLargeDocument(),
    tree: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [treeSupport(supports, "JavaScript").extension],
      inspect: (view) => {
        let tree = treeEnsureSyntaxTree(view.state, view.state.doc.length, 100);
        return {
          language: treeCurrentLanguageName(view),
          lines: String(view.state.doc.lines),
          treeAvailable: String(Boolean(tree) || treeSyntaxTreeAvailable(view.state)),
        };
      },
    },
    lezer: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [lezerSupport(supports, "JavaScript").extension],
      inspect: (view) => {
        let tree = lezerEnsureSyntaxTree(view.state, view.state.doc.length, 100);
        return {
          language: lezerCurrentLanguageName(view),
          lines: String(view.state.doc.lines),
          treeAvailable: String(Boolean(tree) || lezerSyntaxTreeAvailable(view.state)),
        };
      },
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "javascript"),
      equalityCheck("line count", tree.lines, lezer.lines, "4002"),
      equalityCheck("tree available", tree.treeAvailable, lezer.treeAvailable, "true"),
    ],
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

Object.assign(window, {
  __exampleComparison: () => collectComparisonSnapshot(),
});

async function showExample(id: string) {
  let example = examples.find((example) => example.id == id) ?? examples[0]!;
  let run = ++activeRun;
  activeExample = example;
  if (location.hash.slice(1) != example.id) location.hash = example.id;
  for (let button of nav.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.example == example.id);
  }
  title.textContent = example.title;
  source.textContent = example.official.replace("https://codemirror.net/examples/", "examples/");
  summary.textContent = example.summary;
  officialLink.href = example.official;
  setEngineStatus(engines.tree, { status: "Loading grammars" });
  setEngineStatus(engines.lezer, { status: "Loading grammars" });
  renderComparisonLoading();

  let [treeSupports, lezerSupports] = await Promise.all([
    loadSupports(example.tree.languageNames, engines.tree.loadSupport),
    loadSupports(example.lezer.languageNames, engines.lezer.loadSupport),
  ]);
  if (run != activeRun) return;

  destroyViews();
  engines.tree.view = createView(engines.tree.editor, example, [
    treeBasicSetup,
    EditorView.lineWrapping,
    example.tree.extensions(treeSupports),
  ]);
  engines.lezer.view = createView(engines.lezer.editor, example, [
    lezerBasicSetup,
    EditorView.lineWrapping,
    example.lezer.extensions(lezerSupports),
  ]);
  queueStatus();
}

function createView(parent: HTMLElement, example: Example, extensions: Extension[]) {
  parent.replaceChildren();
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: example.doc,
      selection: example.selection ? { anchor: example.selection } : undefined,
      extensions: [
        extensions,
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.selectionSet || update.viewportChanged) queueStatus();
        }),
      ],
    }),
  });
}

function destroyViews() {
  engines.tree.view?.destroy();
  engines.lezer.view?.destroy();
  engines.tree.view = null;
  engines.lezer.view = null;
}

async function loadSupports<Support>(names: readonly string[], loadSupport: LoadSupport<Support>) {
  let supports = new Map<string, Support>();
  await Promise.all(
    names.map(async (name) => {
      supports.set(name, await loadSupport(name));
    }),
  );
  return supports;
}

function loadTreeSupport(name: string) {
  let found = treeLanguageCache.get(name);
  if (found) return found;
  let description = treeLanguages.find((language) => language.name == name);
  if (!description) throw new RangeError(`Missing tree-sitter language-data entry for ${name}`);
  let loaded = description.load();
  treeLanguageCache.set(name, loaded);
  return loaded;
}

function loadLezerSupport(name: string) {
  let found = lezerLanguageCache.get(name);
  if (found) return found;
  let description = lezerLanguages.find((language) => language.name == name);
  if (!description) throw new RangeError(`Missing Lezer language-data entry for ${name}`);
  let loaded = description.load();
  lezerLanguageCache.set(name, loaded);
  return loaded;
}

function treeSupport(supports: SupportMap<TreeLanguageSupport>, name: string) {
  let found = supports.get(name);
  if (!found) throw new RangeError(`Tree-sitter language ${name} was not loaded`);
  return found;
}

function lezerSupport(supports: SupportMap<LezerLanguageSupport>, name: string) {
  let found = supports.get(name);
  if (!found) throw new RangeError(`Lezer language ${name} was not loaded`);
  return found;
}

function queueStatus() {
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(renderStatus, 30);
}

function renderStatus() {
  if (!activeExample) return;
  setEngineStatus(engines.tree, inspectEngine(activeExample.tree, engines.tree.view));
  setEngineStatus(engines.lezer, inspectEngine(activeExample.lezer, engines.lezer.view));
  renderComparison(activeExample);
}

function inspectEngine<Support>(runtime: Runtime<Support>, view: EditorView | null) {
  if (!view) return { status: "Loading grammars" };
  try {
    return runtime.inspect(view);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function setEngineStatus<Support>(engine: EngineState<Support>, status: Status) {
  engine.status = status;
  renderStatusRows(engine.statusList, status);
}

function renderStatusRows(parent: HTMLElement, status: Status) {
  parent.replaceChildren(
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

function renderComparisonLoading() {
  comparisonList.replaceChildren(statusRow("status", "Waiting for both runtimes", "pending"));
}

function renderComparison(example: Example) {
  let tree = engines.tree.status;
  let lezer = engines.lezer.status;
  let rows =
    tree.error || lezer.error
      ? [
          {
            label: "runtime",
            pass: false,
            detail: `tree=${tree.error ?? "ok"}; lezer=${lezer.error ?? "ok"}`,
          },
        ]
      : example.compare(tree, lezer);
  comparisonList.replaceChildren(
    ...rows.map((row) =>
      statusRow(
        row.label,
        `${row.pass ? "pass" : "fail"}: ${row.detail}`,
        row.pass ? "pass" : "fail",
      ),
    ),
  );
}

function statusRow(label: string, value: string, state: "pass" | "fail" | "pending") {
  let row = document.createElement("div");
  row.className = state;
  let key = document.createElement("dt");
  let val = document.createElement("dd");
  key.textContent = label;
  val.textContent = value;
  row.append(key, val);
  return row;
}

function collectComparisonSnapshot() {
  return examples.map((example) => ({
    id: example.id,
    title: example.title,
    tree: example.id == activeExample?.id ? engines.tree.status : null,
    lezer: example.id == activeExample?.id ? engines.lezer.status : null,
    comparison:
      example.id == activeExample?.id
        ? Array.from(comparisonList.querySelectorAll("div")).map((row) => ({
            key: row.querySelector("dt")?.textContent ?? "",
            value: row.querySelector("dd")?.textContent ?? "",
            state: row.className,
          }))
        : null,
  }));
}

function treeReadyTree(view: EditorView) {
  treeEnsureSyntaxTree(view.state, view.state.doc.length, 25);
  return treeSyntaxTree(view.state);
}

function lezerReadyTree(view: EditorView) {
  lezerEnsureSyntaxTree(view.state, view.state.doc.length, 25);
  return lezerSyntaxTree(view.state);
}

function treeCurrentLanguageName(view: EditorView) {
  return view.state.facet(treeLanguageFacet)?.name ?? "none";
}

function lezerCurrentLanguageName(view: EditorView) {
  return view.state.facet(lezerLanguageFacet)?.name ?? "none";
}

function treeCountIsolatedNodes(view: EditorView) {
  let count = 0;
  treeReadyTree(view).iterate({
    enter(node) {
      if (node.type.prop(TreeNodeProp.isolate)) count++;
    },
  });
  return count;
}

function lezerCountIsolatedNodes(view: EditorView) {
  let count = 0;
  lezerReadyTree(view).iterate({
    enter(node) {
      if (node.type.prop(LezerNodeProp.isolate)) count++;
    },
  });
  return count;
}

class BooleanWidget extends WidgetType {
  readonly value: string;

  constructor(value: string) {
    super();
    this.value = value.toLowerCase();
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

function booleanDecorations(
  getTree: (state: EditorState) => {
    iterate: (spec: {
      from?: number;
      to?: number;
      enter: (node: { name: string; from: number; to: number }) => void;
    }) => void;
  },
  nodeNames: readonly string[],
) {
  let names = new Set(nodeNames);
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          getTree(update.startState) != getTree(update.state)
        ) {
          this.decorations = this.build(update.view);
        }
      }

      build(view: EditorView) {
        let builder = new RangeSetBuilder<Decoration>();
        let syntaxTree = getTree(view.state);
        for (let range of view.visibleRanges) {
          syntaxTree.iterate({
            from: range.from,
            to: range.to,
            enter(node) {
              if (names.has(node.name) && node.from < node.to) {
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
}

function treeJsDocCompletions(context: TreeCompletionContext): TreeCompletionResult | null {
  let token = context.matchBefore(/@\w*/);
  if (!token) return null;
  let node = treeSyntaxTree(context.state).resolveInner(context.pos, -1);
  if (node.name != "comment") return null;
  return jsDocResult(token.from);
}

function lezerJsDocCompletions(context: LezerCompletionContext): LezerCompletionResult | null {
  let token = context.matchBefore(/@\w*/);
  if (!token) return null;
  let node = lezerSyntaxTree(context.state).resolveInner(context.pos, -1);
  if (node.name != "BlockComment") return null;
  return jsDocResult(token.from);
}

function jsDocResult(from: number) {
  return {
    from,
    options: [
      { label: "@param", type: "keyword", detail: "document a parameter" },
      { label: "@returns", type: "keyword", detail: "document a return value" },
      { label: "@throws", type: "keyword", detail: "document an exception" },
    ],
    validFor: /^@\w*$/,
  };
}

function regexpDiagnostics(
  state: EditorState,
  getTree: (state: EditorState) => {
    iterate: (spec: { enter: (node: { name: string; from: number; to: number }) => void }) => void;
  },
  regexNodeNames: readonly string[],
) {
  let diagnostics: Diagnostic[] = [];
  let names = new Set(regexNodeNames);
  getTree(state).iterate({
    enter(node) {
      if (names.has(node.name)) {
        diagnostics.push({
          from: node.from,
          to: node.to,
          severity: "warning",
          message: "Regular expression literal found by syntax-tree traversal",
        });
      }
    },
  });
  return diagnostics;
}

const treeExampleHighlightStyle = TreeHighlightStyle.define([
  { tag: treeTags.heading, class: "cmx-heading" },
  { tag: treeTags.strong, class: "cmx-strong" },
  { tag: treeTags.emphasis, class: "cmx-emphasis" },
  { tag: treeTags.monospace, class: "cmx-code" },
]);

const lezerExampleHighlightStyle = LezerHighlightStyle.define([
  { tag: lezerTags.heading, class: "cmx-heading" },
  { tag: lezerTags.strong, class: "cmx-strong" },
  { tag: lezerTags.emphasis, class: "cmx-emphasis" },
  { tag: lezerTags.monospace, class: "cmx-code" },
]);

function highlightProbe(view: EditorView) {
  return {
    heading: view.dom.querySelectorAll(".cmx-heading").length,
    emphasis: view.dom.querySelectorAll(".cmx-emphasis").length,
  };
}

function countBooleanWidgets(view: EditorView) {
  return view.dom.querySelectorAll(".bool-widget").length;
}

function equalityCheck(
  label: string,
  treeValue: string | undefined,
  lezerValue: string | undefined,
  expected?: string,
) {
  let matches =
    expected == null ? treeValue == lezerValue : treeValue == expected && lezerValue == expected;
  let target = expected == null ? "matching values" : expected;
  return {
    label,
    pass: matches,
    detail: `tree=${treeValue ?? "missing"}; lezer=${lezerValue ?? "missing"}; expected=${target}`,
  };
}

function truthyCheck(label: string, pass: boolean, tree: Status, lezer: Status) {
  return {
    label,
    pass,
    detail: `tree=${JSON.stringify(tree)}; lezer=${JSON.stringify(lezer)}`,
  };
}

function presentCheck(
  label: string,
  treeValue: string | undefined,
  lezerValue: string | undefined,
) {
  return {
    label,
    pass: Boolean(treeValue) && Boolean(lezerValue),
    detail: `tree=${treeValue ?? "missing"}; lezer=${lezerValue ?? "missing"}`,
  };
}

function semanticNodeCheck(
  label: string,
  treeValue: string | undefined,
  lezerValue: string | undefined,
  accepted: readonly string[],
) {
  let values = new Set(accepted);
  return {
    label,
    pass: values.has(treeValue ?? "") && values.has(lezerValue ?? ""),
    detail: `tree=${treeValue ?? "missing"}; lezer=${lezerValue ?? "missing"}; accepted=${accepted.join(", ")}`,
  };
}

function makeLargeDocument() {
  let lines: string[] = [];
  for (let i = 0; i < 4000; i++) {
    lines.push(`const value${i} = ${i};`);
  }
  lines.push("export const total = value1 + value3999;");
  return `${lines.join("\n")}\n`;
}
