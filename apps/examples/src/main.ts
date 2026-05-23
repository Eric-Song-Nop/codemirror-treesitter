import "./style.css";
import {
  CompletionContext as TreeCompletionContext,
  autocompletion as treeAutocompletion,
  insertBracket as treeInsertBracket,
  type CompletionResult as TreeCompletionResult,
} from "@codemirror-treesitter/autocomplete";
import { basicSetup as treeBasicSetup } from "@codemirror-treesitter/basic-setup";
import {
  indentWithTab as treeIndentWithTab,
  toggleComment as treeToggleComment,
} from "@codemirror-treesitter/commands";
import { languages as treeLanguages } from "@codemirror-treesitter/language-data";
import {
  HighlightStyle as TreeHighlightStyle,
  NodeProp as TreeNodeProp,
  bidiIsolates as treeBidiIsolates,
  ensureSyntaxTree as treeEnsureSyntaxTree,
  foldable as treeFoldable,
  getIndentation as treeGetIndentation,
  language as treeLanguageFacet,
  matchBrackets as treeMatchBrackets,
  syntaxHighlighting as treeSyntaxHighlighting,
  syntaxTree as treeSyntaxTree,
  syntaxTreeAvailable as treeSyntaxTreeAvailable,
  tags as treeTags,
  type LanguageSupport as TreeLanguageSupport,
} from "@codemirror-treesitter/language";
import {
  LSPClient as TreeLSPClient,
  LSPPlugin as TreeLSPPlugin,
  languageServerExtensions as treeLanguageServerExtensions,
} from "@codemirror-treesitter/lsp-client";
import {
  getChunks as treeGetChunks,
  getOriginalDoc as treeGetOriginalDoc,
  unifiedMergeView as treeUnifiedMergeView,
} from "@codemirror-treesitter/merge";
import {
  CompletionContext as LezerCompletionContext,
  autocompletion as lezerAutocompletion,
  insertBracket as lezerInsertBracket,
  type CompletionResult as LezerCompletionResult,
} from "@codemirror/autocomplete";
import {
  indentWithTab as lezerIndentWithTab,
  toggleComment as lezerToggleComment,
} from "@codemirror/commands";
import { languages as lezerLanguages } from "@codemirror/language-data";
import {
  HighlightStyle as LezerHighlightStyle,
  bidiIsolates as lezerBidiIsolates,
  ensureSyntaxTree as lezerEnsureSyntaxTree,
  foldable as lezerFoldable,
  getIndentation as lezerGetIndentation,
  language as lezerLanguageFacet,
  matchBrackets as lezerMatchBrackets,
  syntaxHighlighting as lezerSyntaxHighlighting,
  syntaxTree as lezerSyntaxTree,
  syntaxTreeAvailable as lezerSyntaxTreeAvailable,
  type LanguageSupport as LezerLanguageSupport,
} from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import {
  LSPClient as LezerLSPClient,
  LSPPlugin as LezerLSPPlugin,
  languageServerExtensions as lezerLanguageServerExtensions,
} from "@codemirror/lsp-client";
import {
  getChunks as lezerGetChunks,
  getOriginalDoc as lezerGetOriginalDoc,
  unifiedMergeView as lezerUnifiedMergeView,
} from "@codemirror/merge";
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

type BenchmarkMetric = {
  label: string;
  tree: number;
  lezer: number;
  unit: "ms" | "ops";
  lowerIsBetter: boolean;
};

type RuntimeBenchmark = {
  load: number;
  state: number;
  mount: number;
  parse: number;
  edit: number;
  inspect: number;
  status: Status;
  parseReady: boolean;
  bytes: number;
  lines: number;
};

type BenchmarkResult = {
  exampleId: string;
  title: string;
  tree: RuntimeBenchmark;
  lezer: RuntimeBenchmark;
  metrics: readonly BenchmarkMetric[];
  comparisons: readonly CompareRow[];
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
let benchmarkRun = 0;
let benchmarkBusy = false;

const benchmarkResults = new Map<string, BenchmarkResult>();
const treeLanguageNames = new Set(treeLanguages.map((language) => language.name));
const lezerLanguageNames = new Set(lezerLanguages.map((language) => language.name));
const commonLanguageNames = [...treeLanguageNames]
  .filter((name) => lezerLanguageNames.has(name))
  .sort((a, b) => a.localeCompare(b));
const treeOnlyLanguageNames = [...treeLanguageNames]
  .filter((name) => !lezerLanguageNames.has(name))
  .sort((a, b) => a.localeCompare(b));
const lezerOnlyLanguageNames = [...lezerLanguageNames]
  .filter((name) => !treeLanguageNames.has(name))
  .sort((a, b) => a.localeCompare(b));

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
    <section class="benchmark-console" aria-label="Benchmark suite">
      <header class="benchmark-toolbar">
        <div>
          <p class="source">Benchmark Suite</p>
          <h3>Language Editing Latency</h3>
        </div>
        <div class="benchmark-actions">
          <button id="run-active-benchmark" type="button">Run Active</button>
          <button id="run-suite-benchmark" type="button">Run Suite</button>
        </div>
      </header>
      <div id="benchmark-summary" class="metric-strip"></div>
      <div class="benchmark-grid">
        <section class="benchmark-panel">
          <header>
            <h4>Active Feature Metrics</h4>
            <p id="benchmark-status">No benchmark run yet</p>
          </header>
          <div id="active-benchmark" class="metrics-table"></div>
        </section>
        <section class="benchmark-panel">
          <header>
            <h4>Suite Results</h4>
            <p id="suite-status">0 examples measured</p>
          </header>
          <div id="suite-benchmark" class="suite-table"></div>
        </section>
      </div>
    </section>
    <section class="coverage-panel" aria-label="Language coverage">
      <header>
        <div>
          <p class="source">Language Coverage</p>
          <h3>Tree-sitter package span against CodeMirror language-data</h3>
        </div>
        <div id="coverage-stats" class="coverage-stats"></div>
      </header>
      <div id="language-grid" class="language-grid"></div>
    </section>
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
const runActiveBenchmarkButton =
  document.querySelector<HTMLButtonElement>("#run-active-benchmark")!;
const runSuiteBenchmarkButton = document.querySelector<HTMLButtonElement>("#run-suite-benchmark")!;
const benchmarkSummary = document.querySelector<HTMLElement>("#benchmark-summary")!;
const benchmarkStatus = document.querySelector<HTMLElement>("#benchmark-status")!;
const suiteStatus = document.querySelector<HTMLElement>("#suite-status")!;
const activeBenchmark = document.querySelector<HTMLElement>("#active-benchmark")!;
const suiteBenchmark = document.querySelector<HTMLElement>("#suite-benchmark")!;
const coverageStats = document.querySelector<HTMLElement>("#coverage-stats")!;
const languageGrid = document.querySelector<HTMLElement>("#language-grid")!;

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

const mergeOriginalDoc = `const rate = 1.2;

function total(items) {
  const subtotal = items.reduce((sum, item) => sum + item.value, 0);
  return subtotal * rate;
}
`;

const lspMarkdownSample = {
  kind: "markdown" as const,
  value: `Hover renders markup and highlighted code blocks.

\`\`\`javascript
const answer = 42;
if (answer < limit) console.log(answer);
\`\`\`
`,
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
    id: "indent-fold",
    title: "Indentation and Folding",
    official: "https://codemirror.net/examples/fold/",
    summary:
      "Indent services and fold metadata are read from the same JavaScript syntax tree shape used by editor commands.",
    doc: `function render(items) {
  return items.map((item) => {
    if (item.active) {
      return { label: item.label };
    }
    return null;
  });
}
`,
    tree: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [treeSupport(supports, "JavaScript").extension],
      inspect: (view) => {
        treeReadyTree(view);
        let indentLine = view.state.doc.line(2);
        let foldLine = view.state.doc.line(1);
        let fold = treeFoldable(view.state, foldLine.from, foldLine.to);
        return {
          language: treeCurrentLanguageName(view),
          lineIndent: String(treeGetIndentation(view.state, indentLine.from)),
          foldRange: fold ? `${fold.from}-${fold.to}` : "none",
        };
      },
    },
    lezer: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [lezerSupport(supports, "JavaScript").extension],
      inspect: (view) => {
        lezerReadyTree(view);
        let indentLine = view.state.doc.line(2);
        let foldLine = view.state.doc.line(1);
        let fold = lezerFoldable(view.state, foldLine.from, foldLine.to);
        return {
          language: lezerCurrentLanguageName(view),
          lineIndent: String(lezerGetIndentation(view.state, indentLine.from)),
          foldRange: fold ? `${fold.from}-${fold.to}` : "none",
        };
      },
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "javascript"),
      equalityCheck("indentation", tree.lineIndent, lezer.lineIndent, "2"),
      presentCheck(
        "fold range",
        tree.foldRange == "none" ? undefined : tree.foldRange,
        lezer.foldRange == "none" ? undefined : lezer.foldRange,
      ),
    ],
  },
  {
    id: "comments",
    title: "Comment Commands",
    official: "https://codemirror.net/examples/change/",
    summary:
      "Command behavior is benchmarked through language data by toggling line comments without mutating the visible editor.",
    doc: `const value = 1;
const next = value + 1;
`,
    tree: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [treeSupport(supports, "JavaScript").extension],
      inspect: (view) => {
        let commentTokens = view.state.languageDataAt<{ line?: string }>("commentTokens", 0)[0];
        return {
          language: treeCurrentLanguageName(view),
          lineToken: commentTokens?.line ?? "none",
          toggledPrefix: treeCommentPrefix(view),
        };
      },
    },
    lezer: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [lezerSupport(supports, "JavaScript").extension],
      inspect: (view) => {
        let commentTokens = view.state.languageDataAt<{ line?: string }>("commentTokens", 0)[0];
        return {
          language: lezerCurrentLanguageName(view),
          lineToken: commentTokens?.line ?? "none",
          toggledPrefix: lezerCommentPrefix(view),
        };
      },
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "javascript"),
      equalityCheck("line comment token", tree.lineToken, lezer.lineToken, "//"),
      equalityCheck("toggle comment", tree.toggledPrefix, lezer.toggledPrefix, "//"),
    ],
  },
  {
    id: "bracket-match",
    title: "Bracket Matching",
    official: "https://codemirror.net/examples/styling/",
    summary:
      "Bracket matching is checked directly against the syntax-aware matchBrackets helper in both runtimes.",
    doc: `function call() {
  return [1, 2, 3].map((value) => value * 2);
}
`,
    tree: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [treeSupport(supports, "JavaScript").extension],
      inspect: (view) => {
        treeReadyTree(view);
        let result = treeBracketMatch(view);
        return {
          language: treeCurrentLanguageName(view),
          matched: String(result.matched),
          matchRange: result.range,
        };
      },
    },
    lezer: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [lezerSupport(supports, "JavaScript").extension],
      inspect: (view) => {
        lezerReadyTree(view);
        let result = lezerBracketMatch(view);
        return {
          language: lezerCurrentLanguageName(view),
          matched: String(result.matched),
          matchRange: result.range,
        };
      },
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "javascript"),
      equalityCheck("matched bracket", tree.matched, lezer.matched, "true"),
      presentCheck(
        "match range",
        tree.matchRange == "none" ? undefined : tree.matchRange,
        lezer.matchRange == "none" ? undefined : lezer.matchRange,
      ),
    ],
  },
  {
    id: "close-brackets",
    title: "Close Brackets",
    official: "https://codemirror.net/examples/autocompletion/",
    summary:
      "Close-bracket language data and insertBracket transactions are compared from identical cursor state.",
    doc: "const payload = ",
    selection: 16,
    tree: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [treeSupport(supports, "JavaScript").extension],
      inspect: (view) => {
        let config = view.state.languageDataAt<{ brackets?: readonly string[] }>(
          "closeBrackets",
          view.state.selection.main.head,
        )[0];
        return {
          language: treeCurrentLanguageName(view),
          brackets: config?.brackets?.join(" ") ?? "none",
          insertedPair: treeInsertedBracketPair(view),
        };
      },
    },
    lezer: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [lezerSupport(supports, "JavaScript").extension],
      inspect: (view) => {
        let config = view.state.languageDataAt<{ brackets?: readonly string[] }>(
          "closeBrackets",
          view.state.selection.main.head,
        )[0];
        return {
          language: lezerCurrentLanguageName(view),
          brackets: config?.brackets?.join(" ") ?? "none",
          insertedPair: lezerInsertedBracketPair(view),
        };
      },
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "javascript"),
      truthyCheck(
        "bracket config",
        Boolean(tree.brackets?.includes("{")) && Boolean(lezer.brackets?.includes("{")),
        tree,
        lezer,
      ),
      equalityCheck("inserted pair", tree.insertedPair, lezer.insertedPair, "{}"),
    ],
  },
  {
    id: "merge-view",
    title: "Merge View",
    official: "https://codemirror.net/docs/ref/#merge",
    summary:
      "Unified merge view compares a changed JavaScript document against an original and highlights deletion widgets through the active parser.",
    doc: `const rate = 1.2;

function total(items) {
  return items
    .filter((item) => item.active)
    .reduce((sum, item) => sum + item.value, 0) * rate;
}
`,
    tree: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [
        treeSupport(supports, "JavaScript").extension,
        treeSyntaxHighlighting(treeLspHighlightStyle),
        treeUnifiedMergeView({
          original: mergeOriginalDoc,
          syntaxHighlightDeletions: true,
        }),
      ],
      inspect: (view) => {
        let merge = treeGetChunks(view.state);
        return {
          language: treeCurrentLanguageName(view),
          chunks: String(merge?.chunks.length ?? 0),
          side: merge?.side ?? "none",
          originalLines: String(treeGetOriginalDoc(view.state).lines),
          deletedHighlights: String(
            view.dom.querySelectorAll(".cm-deletedChunk .cmx-keyword").length,
          ),
        };
      },
    },
    lezer: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [
        lezerSupport(supports, "JavaScript").extension,
        lezerSyntaxHighlighting(lezerLspHighlightStyle),
        lezerUnifiedMergeView({
          original: mergeOriginalDoc,
          syntaxHighlightDeletions: true,
        }),
      ],
      inspect: (view) => {
        let merge = lezerGetChunks(view.state);
        return {
          language: lezerCurrentLanguageName(view),
          chunks: String(merge?.chunks.length ?? 0),
          side: merge?.side ?? "none",
          originalLines: String(lezerGetOriginalDoc(view.state).lines),
          deletedHighlights: String(
            view.dom.querySelectorAll(".cm-deletedChunk .cmx-keyword").length,
          ),
        };
      },
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "javascript"),
      truthyCheck(
        "changed chunks",
        Number(tree.chunks) > 0 && Number(lezer.chunks) > 0,
        tree,
        lezer,
      ),
      equalityCheck("merge side", tree.side, lezer.side, "b"),
      equalityCheck("original document", tree.originalLines, lezer.originalLines),
    ],
  },
  {
    id: "lsp-client",
    title: "LSP Client Rendering",
    official: "https://codemirror.net/docs/ref/#lsp-client",
    summary:
      "A mock LSP client mounts the plugin and renders Markdown hover documentation with JavaScript code-block highlighting.",
    doc: `const limit = 100;
const answer = 42;

function report() {
  return answer < limit ? "ok" : "large";
}
`,
    tree: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [
        treeSupport(supports, "JavaScript").extension,
        treeSyntaxHighlighting(treeLspHighlightStyle),
        treeLspExtension(treeSupport(supports, "JavaScript")),
      ],
      inspect: treeLspStatus,
    },
    lezer: {
      languageNames: ["JavaScript"],
      extensions: (supports) => [
        lezerSupport(supports, "JavaScript").extension,
        lezerSyntaxHighlighting(lezerLspHighlightStyle),
        lezerLspExtension(lezerSupport(supports, "JavaScript")),
      ],
      inspect: lezerLspStatus,
    },
    compare: (tree, lezer) => [
      equalityCheck("language", tree.language, lezer.language, "javascript"),
      equalityCheck("plugin", tree.plugin, lezer.plugin, "mounted"),
      equalityCheck("workspace file", tree.workspaceFiles, lezer.workspaceFiles, "1"),
      equalityCheck("rendered markdown", tree.renderedMarkdown, lezer.renderedMarkdown, "true"),
      truthyCheck("tree-sitter highlighting", tree.highlightedMarkdown == "true", tree, lezer),
      equalityCheck("escaped markdown", tree.escapedMarkdown, lezer.escapedMarkdown, "true"),
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

runActiveBenchmarkButton.addEventListener("click", () => void runBenchmarks("active"));
runSuiteBenchmarkButton.addEventListener("click", () => void runBenchmarks("suite"));
renderLanguageCoverage();
renderBenchmarkResults();

void showExample(location.hash.slice(1) || examples[0]!.id);
window.addEventListener(
  "hashchange",
  () => void showExample(location.hash.slice(1) || examples[0]!.id),
);

Object.assign(window, {
  __exampleComparison: () => collectComparisonSnapshot(),
  __benchmarkResults: () => collectBenchmarkSnapshot(),
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
  renderBenchmarkResults();
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

async function runBenchmarks(scope: "active" | "suite") {
  if (benchmarkBusy) return;
  let run = ++benchmarkRun;
  benchmarkBusy = true;
  setBenchmarkButtons(true);
  let targets = scope == "active" && activeExample ? [activeExample] : examples;
  benchmarkStatus.textContent =
    scope == "active" ? "Measuring active feature" : "Measuring full suite";
  suiteStatus.textContent = `${benchmarkResults.size}/${examples.length} examples measured`;

  try {
    for (let index = 0; index < targets.length; index++) {
      if (run != benchmarkRun) return;
      let example = targets[index]!;
      benchmarkStatus.textContent = `Measuring ${example.title}`;
      let result = await benchmarkExample(example);
      benchmarkResults.set(example.id, result);
      suiteStatus.textContent = `${benchmarkResults.size}/${examples.length} examples measured`;
      renderBenchmarkResults();
      await nextFrame();
    }
  } finally {
    if (run == benchmarkRun) {
      benchmarkBusy = false;
      setBenchmarkButtons(false);
      benchmarkStatus.textContent =
        scope == "active" && activeExample
          ? `Measured ${activeExample.title}`
          : `Measured ${benchmarkResults.size}/${examples.length} examples`;
      renderBenchmarkResults();
    }
  }
}

function setBenchmarkButtons(disabled: boolean) {
  runActiveBenchmarkButton.disabled = disabled;
  runSuiteBenchmarkButton.disabled = disabled;
}

async function benchmarkExample(example: Example): Promise<BenchmarkResult> {
  let [tree, lezer] = await Promise.all([
    benchmarkRuntime(engines.tree, example.tree, example),
    benchmarkRuntime(engines.lezer, example.lezer, example),
  ]);
  let comparisons =
    tree.status.error || lezer.status.error
      ? [
          {
            label: "runtime",
            pass: false,
            detail: `tree=${tree.status.error ?? "ok"}; lezer=${lezer.status.error ?? "ok"}`,
          },
        ]
      : example.compare(tree.status, lezer.status);
  return {
    exampleId: example.id,
    title: example.title,
    tree,
    lezer,
    metrics: benchmarkMetrics(tree, lezer),
    comparisons,
  };
}

async function benchmarkRuntime<Support>(
  engine: EngineState<Support>,
  runtime: Runtime<Support>,
  example: Example,
): Promise<RuntimeBenchmark> {
  let load = 0;
  let stateCreate = 0;
  let mount = 0;
  let parse = 0;
  let edit = 0;
  let inspect = 0;
  let parseReady = false;
  let status: Status = {};
  let view: EditorView | null = null;
  let host = createBenchmarkHost();

  try {
    let loadStart = performance.now();
    let supports = await loadSupports(runtime.languageNames, engine.loadSupport);
    load = performance.now() - loadStart;

    let extensions = [
      engine.id == "tree" ? treeBasicSetup : lezerBasicSetup,
      EditorView.lineWrapping,
      runtime.extensions(supports),
    ];
    let stateStart = performance.now();
    let state = EditorState.create({
      doc: example.doc,
      selection: example.selection ? { anchor: example.selection } : undefined,
      extensions,
    });
    stateCreate = performance.now() - stateStart;

    let mountStart = performance.now();
    view = new EditorView({ parent: host, state });
    mount = performance.now() - mountStart;
    await nextFrame();

    let parseStart = performance.now();
    parseReady = ensureRuntimeTree(engine.id, view.state, parseBudget(example));
    parse = performance.now() - parseStart;

    let editStart = performance.now();
    let cycles = editCycles(example);
    let anchor = view.state.doc.length;
    for (let i = 0; i < cycles; i++) {
      view.dispatch({ changes: { from: anchor, insert: " " } });
      ensureRuntimeTree(engine.id, view.state, parseBudget(example));
      view.dispatch({ changes: { from: anchor, to: anchor + 1 } });
      ensureRuntimeTree(engine.id, view.state, parseBudget(example));
    }
    edit = (performance.now() - editStart) / (cycles * 2);
    await nextFrame();

    let inspectStart = performance.now();
    status = runtime.inspect(view);
    inspect = performance.now() - inspectStart;
  } catch (error) {
    status = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    view?.destroy();
    host.remove();
  }

  return {
    load,
    state: stateCreate,
    mount,
    parse,
    edit,
    inspect,
    status,
    parseReady,
    bytes: textBytes(example.doc),
    lines: EditorState.create({ doc: example.doc }).doc.lines,
  };
}

function benchmarkMetrics(tree: RuntimeBenchmark, lezer: RuntimeBenchmark): BenchmarkMetric[] {
  return [
    metric("Support load", tree.load, lezer.load),
    metric("State create", tree.state, lezer.state),
    metric("Editor mount", tree.mount, lezer.mount),
    metric("Parse to end", tree.parse, lezer.parse),
    metric("Incremental edit", tree.edit, lezer.edit),
    metric("Feature inspect", tree.inspect, lezer.inspect),
    metric("Total measured", runtimeTotal(tree), runtimeTotal(lezer)),
  ];
}

function metric(label: string, tree: number, lezer: number): BenchmarkMetric {
  return { label, tree, lezer, unit: "ms", lowerIsBetter: true };
}

function runtimeTotal(result: RuntimeBenchmark) {
  return result.load + result.state + result.mount + result.parse + result.inspect + result.edit;
}

function ensureRuntimeTree(engine: EngineId, state: EditorState, timeout: number) {
  if (engine == "tree") {
    return (
      Boolean(treeEnsureSyntaxTree(state, state.doc.length, timeout)) ||
      treeSyntaxTreeAvailable(state)
    );
  }
  return (
    Boolean(lezerEnsureSyntaxTree(state, state.doc.length, timeout)) ||
    lezerSyntaxTreeAvailable(state)
  );
}

function parseBudget(example: Example) {
  return Math.min(1800, Math.max(80, Math.ceil(example.doc.length / 35)));
}

function editCycles(example: Example) {
  return example.doc.length > 30_000 ? 4 : 20;
}

function createBenchmarkHost() {
  let host = document.createElement("div");
  host.className = "benchmark-host";
  document.body.append(host);
  return host;
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function textBytes(text: string) {
  return new TextEncoder().encode(text).byteLength;
}

function renderBenchmarkResults() {
  renderBenchmarkSummary();
  renderActiveBenchmark();
  renderSuiteBenchmark();
}

function renderBenchmarkSummary() {
  let results = [...benchmarkResults.values()];
  let checks = results.flatMap((result) => result.comparisons);
  let passed = checks.filter((row) => row.pass).length;
  let treeTotal = results.reduce((sum, result) => sum + runtimeTotal(result.tree), 0);
  let lezerTotal = results.reduce((sum, result) => sum + runtimeTotal(result.lezer), 0);
  benchmarkSummary.replaceChildren(
    metricTile("Measured", `${results.length}/${examples.length}`, "features"),
    metricTile("Parity", checks.length ? `${passed}/${checks.length}` : "pending", "checks"),
    metricTile("Tree-sitter", results.length ? formatMs(treeTotal) : "pending", "suite total"),
    metricTile("Lezer", results.length ? formatMs(lezerTotal) : "pending", "suite total"),
    metricTile(
      "Coverage",
      `${commonLanguageNames.length}/${lezerLanguageNames.size}`,
      "shared languages",
    ),
  );
}

function metricTile(label: string, value: string, detail: string) {
  let tile = document.createElement("article");
  let key = document.createElement("span");
  let amount = document.createElement("strong");
  let note = document.createElement("small");
  key.textContent = label;
  amount.textContent = value;
  note.textContent = detail;
  tile.append(key, amount, note);
  return tile;
}

function renderActiveBenchmark() {
  let result = activeExample ? benchmarkResults.get(activeExample.id) : undefined;
  if (!benchmarkBusy) {
    benchmarkStatus.textContent = result
      ? `Measured ${result.title}`
      : "No benchmark run for active feature";
  }
  if (!result) {
    activeBenchmark.replaceChildren(emptyState("Awaiting benchmark data."));
    return;
  }
  activeBenchmark.replaceChildren(
    tableRow(["Metric", "Tree-sitter", "Lezer", "Delta", "Leader"], "header"),
    ...result.metrics.map((row) =>
      tableRow([
        row.label,
        formatMetric(row.tree, row.unit),
        formatMetric(row.lezer, row.unit),
        formatDelta(row),
        metricLeader(row),
      ]),
    ),
    tableRow(
      [
        "Feature checks",
        `${result.comparisons.filter((row) => row.pass).length}/${result.comparisons.length}`,
        result.tree.parseReady && result.lezer.parseReady ? "parsed" : "partial",
        `${result.tree.lines} lines`,
        `${formatInteger(result.tree.bytes)} bytes`,
      ],
      "summary",
    ),
  );
}

function renderSuiteBenchmark() {
  let results = examples
    .map((example) => benchmarkResults.get(example.id))
    .filter((result): result is BenchmarkResult => Boolean(result));
  suiteStatus.textContent = `${results.length}/${examples.length} examples measured`;
  if (!results.length) {
    suiteBenchmark.replaceChildren(emptyState("Awaiting suite data."));
    return;
  }
  suiteBenchmark.replaceChildren(
    tableRow(["Feature", "Tree total", "Lezer total", "Leader", "Checks"], "header"),
    ...results.map((result) => {
      let total = metric("total", runtimeTotal(result.tree), runtimeTotal(result.lezer));
      return tableRow([
        result.title,
        formatMs(total.tree),
        formatMs(total.lezer),
        metricLeader(total),
        `${result.comparisons.filter((row) => row.pass).length}/${result.comparisons.length}`,
      ]);
    }),
  );
}

function renderLanguageCoverage() {
  coverageStats.replaceChildren(
    coverageStat("Common", commonLanguageNames.length),
    coverageStat("Tree-only", treeOnlyLanguageNames.length),
    coverageStat("Lezer-only", lezerOnlyLanguageNames.length),
  );
  languageGrid.replaceChildren(
    languageGroup("Common", commonLanguageNames),
    languageGroup("Tree-only", treeOnlyLanguageNames),
    languageGroup("Lezer-only", lezerOnlyLanguageNames),
  );
}

function coverageStat(label: string, value: number) {
  let stat = document.createElement("span");
  stat.textContent = `${label}: ${value}`;
  return stat;
}

function languageGroup(label: string, names: readonly string[]) {
  let group = document.createElement("section");
  let title = document.createElement("h4");
  let list = document.createElement("div");
  title.textContent = label;
  list.className = "language-pills";
  list.replaceChildren(...names.map((name) => languagePill(name)));
  group.append(title, list);
  return group;
}

function languagePill(name: string) {
  let pill = document.createElement("span");
  pill.textContent = name;
  return pill;
}

function tableRow(values: readonly string[], kind = "") {
  let row = document.createElement("div");
  row.className = kind;
  row.replaceChildren(
    ...values.map((value) => {
      let cell = document.createElement("span");
      cell.textContent = value;
      return cell;
    }),
  );
  return row;
}

function emptyState(message: string) {
  let empty = document.createElement("p");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function formatMetric(value: number, unit: BenchmarkMetric["unit"]) {
  return unit == "ms" ? formatMs(value) : formatInteger(value);
}

function formatMs(value: number) {
  if (!Number.isFinite(value)) return "n/a";
  if (Math.abs(value) < 10) return `${value.toFixed(2)}ms`;
  if (Math.abs(value) < 100) return `${value.toFixed(1)}ms`;
  return `${Math.round(value)}ms`;
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatDelta(metric: BenchmarkMetric) {
  let delta = metric.tree - metric.lezer;
  if (Math.abs(delta) < 0.01) return "even";
  let sign = delta > 0 ? "+" : "";
  let percent = metric.lezer ? `, ${sign}${((delta / metric.lezer) * 100).toFixed(1)}%` : "";
  return `${sign}${formatMs(delta)}${percent}`;
}

function metricLeader(metric: BenchmarkMetric) {
  let delta = metric.tree - metric.lezer;
  if (Math.abs(delta) < 0.05) return "tie";
  let treeWins = metric.lowerIsBetter ? delta < 0 : delta > 0;
  return treeWins ? "Tree-sitter" : "Lezer";
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

function collectBenchmarkSnapshot() {
  return [...benchmarkResults.values()].map((result) => ({
    id: result.exampleId,
    title: result.title,
    tree: result.tree,
    lezer: result.lezer,
    metrics: result.metrics,
    comparisons: result.comparisons,
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

function treeCommentPrefix(view: EditorView) {
  let next = view.state;
  let ran = treeToggleComment({
    state: view.state,
    dispatch(transaction) {
      next = transaction.state;
    },
  });
  return ran ? next.doc.line(1).text.trimStart().slice(0, 2) : "none";
}

function lezerCommentPrefix(view: EditorView) {
  let next = view.state;
  let ran = lezerToggleComment({
    state: view.state,
    dispatch(transaction) {
      next = transaction.state;
    },
  });
  return ran ? next.doc.line(1).text.trimStart().slice(0, 2) : "none";
}

function treeBracketMatch(view: EditorView) {
  let pos = view.state.doc.toString().indexOf("{");
  let match = treeMatchBrackets(view.state, pos, 1);
  return {
    matched: Boolean(match?.matched),
    range: match?.end ? `${match.start.from}-${match.end.to}` : "none",
  };
}

function lezerBracketMatch(view: EditorView) {
  let pos = view.state.doc.toString().indexOf("{");
  let match = lezerMatchBrackets(view.state, pos, 1);
  return {
    matched: Boolean(match?.matched),
    range: match?.end ? `${match.start.from}-${match.end.to}` : "none",
  };
}

function treeInsertedBracketPair(view: EditorView) {
  let head = view.state.selection.main.head;
  let transaction = treeInsertBracket(view.state, "{");
  return transaction ? transaction.state.sliceDoc(head, head + 2) : "none";
}

function lezerInsertedBracketPair(view: EditorView) {
  let head = view.state.selection.main.head;
  let transaction = lezerInsertBracket(view.state, "{");
  return transaction ? transaction.state.sliceDoc(head, head + 2) : "none";
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

function treeLspExtension(support: TreeLanguageSupport) {
  let client = new TreeLSPClient({
    timeout: 50,
    extensions: treeLanguageServerExtensions(),
    highlightLanguage: (name) => (lspLanguageMatches(name) ? support.language : null),
  });
  return TreeLSPPlugin.create(client, "file:///examples/lsp-client.ts", "javascript");
}

function lezerLspExtension(support: LezerLanguageSupport) {
  let client = new LezerLSPClient({
    timeout: 50,
    extensions: lezerLanguageServerExtensions(),
    highlightLanguage: (name) => (lspLanguageMatches(name) ? support.language : null),
  });
  return LezerLSPPlugin.create(client, "file:///examples/lsp-client.ts", "javascript");
}

function lspLanguageMatches(name: string) {
  return /^(?:javascript|js|typescript|ts)$/.test(name.toLowerCase());
}

function treeLspStatus(view: EditorView) {
  let plugin = TreeLSPPlugin.get(view);
  let html = plugin?.docToHTML(lspMarkdownSample, "markdown") ?? "";
  return lspStatus(
    treeCurrentLanguageName(view),
    Boolean(plugin),
    plugin?.client.workspace.files.length ?? 0,
    html,
  );
}

function lezerLspStatus(view: EditorView) {
  let plugin = LezerLSPPlugin.get(view);
  let html = plugin?.docToHTML(lspMarkdownSample, "markdown") ?? "";
  return lspStatus(
    lezerCurrentLanguageName(view),
    Boolean(plugin),
    plugin?.client.workspace.files.length ?? 0,
    html,
  );
}

function lspStatus(languageName: string, plugin: boolean, workspaceFiles: number, html: string) {
  return {
    language: languageName,
    plugin: plugin ? "mounted" : "missing",
    workspaceFiles: String(workspaceFiles),
    renderedMarkdown: String(html.includes("<pre><code")),
    highlightedMarkdown: String(html.includes("<span")),
    escapedMarkdown: String(html.includes("&lt;")),
  };
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

const treeLspHighlightStyle = TreeHighlightStyle.define([
  { tag: treeTags.keyword, class: "cmx-keyword" },
  { tag: treeTags.number, class: "cmx-number" },
  { tag: treeTags.variableName, class: "cmx-variable" },
]);

const lezerLspHighlightStyle = LezerHighlightStyle.define([
  { tag: lezerTags.keyword, class: "cmx-keyword" },
  { tag: lezerTags.number, class: "cmx-number" },
  { tag: lezerTags.variableName, class: "cmx-variable" },
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
