import "./style.css";
import { EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror-treesitter/language";
import {
  defineTyporaEditor,
  type TyporaEditorElement,
} from "@codemirror-treesitter/typora-runtime";
import { createInitialMarkdown } from "@codemirror-treesitter/typora-runtime/fixtures";
import type { EditorView } from "@codemirror/view";

type BenchmarkGroup = "clipboard" | "delete" | "edit" | "render" | "selection";

export type TyporaBenchmarkMetric = {
  avg: number;
  label: string;
  max: number;
  min: number;
  p50: number;
  p95: number;
  samples: number[];
  unit: "ms";
};

export type TyporaBenchmarkCaseResult = {
  bytes: number;
  group: BenchmarkGroup;
  id: string;
  label: string;
  lines: number;
  metrics: TyporaBenchmarkMetric[];
  stats: Record<string, number>;
};

export type TyporaBenchmarkResult = {
  cases: TyporaBenchmarkCaseResult[];
  groups: Record<string, { avg: number; max: number; p95: number }>;
  startedAt: string;
  totalMs: number;
  userAgent: string;
};

export type TyporaBenchmarkOptions = {
  onCase?: (result: TyporaBenchmarkCaseResult) => void;
};

type BenchmarkStep = {
  iterations: number;
  label: string;
  run: (view: EditorView, iteration: number) => Promise<void> | void;
};

type BenchmarkCase = {
  doc: string;
  group: BenchmarkGroup;
  id: string;
  label: string;
  steps: BenchmarkStep[];
};

type BenchmarkSession = {
  editor: TyporaEditorElement;
  host: HTMLElement;
};

type TyporaBenchmarkApi = {
  last: () => TyporaBenchmarkResult | null;
  run: (options?: TyporaBenchmarkOptions) => Promise<TyporaBenchmarkResult>;
};

declare global {
  interface Window {
    __typoraBenchmark?: TyporaBenchmarkApi;
  }
}

const mediumDoc = createInitialMarkdown();
const largeDoc = buildBenchmarkMarkdown(72);
const editDoc = buildBenchmarkMarkdown(24);
const pasteDoc = buildBenchmarkMarkdown(10);
const benchmarkResultElementId = "typora-benchmark-result";
const benchmarkCases: BenchmarkCase[] = [
  {
    doc: mediumDoc,
    group: "render",
    id: "render-medium",
    label: "Render medium mixed Markdown",
    steps: [
      {
        iterations: 18,
        label: "viewport scroll layout",
        run(view, iteration) {
          scrollToRatio(view, iteration / 17);
        },
      },
    ],
  },
  {
    doc: largeDoc,
    group: "render",
    id: "render-large-scroll",
    label: "Render large document and scroll",
    steps: [
      {
        iterations: 28,
        label: "large viewport scroll",
        run(view, iteration) {
          scrollToRatio(view, bounceRatio(iteration, 28));
        },
      },
    ],
  },
  {
    doc: editDoc,
    group: "edit",
    id: "edit-prose-typing",
    label: "Edit prose by typing",
    steps: [
      {
        iterations: 48,
        label: "single character input",
        run: typeIntoFirstParagraph("typora benchmark input "),
      },
    ],
  },
  {
    doc: editDoc,
    group: "edit",
    id: "edit-markdown-structures",
    label: "Edit Markdown structures",
    steps: [
      {
        iterations: 30,
        label: "append task, quote, and code lines",
        run(view, iteration) {
          let insert =
            iteration % 3 == 0
              ? `\n- [ ] benchmark task ${iteration}`
              : iteration % 3 == 1
                ? `\n> benchmark quote ${iteration} with **strong** text`
                : `\n\`\`\`ts\nconst benchmark${iteration} = ${iteration};\n\`\`\``;
          view.dispatch({
            changes: { from: view.state.doc.length, insert },
            selection: { anchor: view.state.doc.length + insert.length },
            userEvent: "input.benchmarkStructure",
          });
        },
      },
    ],
  },
  {
    doc: `${editDoc}\n\n${alphabetBlock(12)}`,
    group: "delete",
    id: "delete-characters",
    label: "Delete characters in prose",
    steps: [
      {
        iterations: 52,
        label: "single character delete",
        run(view) {
          let from = view.state.doc.toString().indexOf("abcdefghijklmnopqrstuvwxyz");
          if (from < 0) return;
          view.dispatch({
            changes: { from, to: from + 1 },
            selection: { anchor: from },
            userEvent: "delete.backward",
          });
        },
      },
    ],
  },
  {
    doc: buildDeleteBlockMarkdown(18),
    group: "delete",
    id: "delete-blocks",
    label: "Delete selected blocks",
    steps: [
      {
        iterations: 12,
        label: "multi-line block delete",
        run: deleteLastBenchmarkBlock(),
      },
    ],
  },
  {
    doc: pasteDoc,
    group: "clipboard",
    id: "clipboard-copy-paste",
    label: "Copy and paste Markdown",
    steps: [
      {
        iterations: 22,
        label: "copy selected section",
        run: copyBenchmarkSection(),
      },
      {
        iterations: 12,
        label: "paste large block",
        run: pasteLargeBlock(),
      },
      {
        iterations: 10,
        label: "paste over selection",
        run: pasteOverSelection(),
      },
    ],
  },
  {
    doc: largeDoc,
    group: "selection",
    id: "selection-navigation",
    label: "Selection and cursor movement",
    steps: [
      {
        iterations: 60,
        label: "cursor scan",
        run: moveCursorAcrossDocument(),
      },
      {
        iterations: 34,
        label: "range selection drag",
        run: expandSelectionRange(),
      },
      {
        iterations: 24,
        label: "multiple cursors",
        run: moveMultipleCursors(),
      },
    ],
  },
];

let lastBenchmarkResult: TyporaBenchmarkResult | null = null;
let layoutProbe = 0;
let clipboardBuffer = "";

defineTyporaEditor();

export function installTyporaBenchmark() {
  window.__typoraBenchmark = {
    last: () => lastBenchmarkResult,
    run: runTyporaBenchmark,
  };

  let params = new URLSearchParams(window.location.search);
  let panel = mountBenchmarkPanel();
  let autoRun = params.get("benchmark") == "run" || params.get("benchmark") == "auto";
  if (autoRun) void runPanelBenchmark(panel);
}

export async function runTyporaBenchmark(
  options: TyporaBenchmarkOptions = {},
): Promise<TyporaBenchmarkResult> {
  let startedAt = new Date().toISOString();
  let suiteStart = performance.now();
  let cases: TyporaBenchmarkCaseResult[] = [];

  for (let benchmarkCase of benchmarkCases) {
    let result = await runBenchmarkCase(benchmarkCase);
    cases.push(result);
    options.onCase?.(result);
    await nextFrame();
  }

  let result: TyporaBenchmarkResult = {
    cases,
    groups: summarizeGroups(cases),
    startedAt,
    totalMs: performance.now() - suiteStart,
    userAgent: navigator.userAgent,
  };
  lastBenchmarkResult = result;
  publishBenchmarkResult(result);
  return lastBenchmarkResult;
}

async function runBenchmarkCase(benchmarkCase: BenchmarkCase): Promise<TyporaBenchmarkCaseResult> {
  let session = await createBenchmarkSession(benchmarkCase.doc);
  let view = benchmarkView(session);
  let metrics: TyporaBenchmarkMetric[] = [];

  try {
    metrics.push(await measureColdRender(session, benchmarkCase.label));
    for (let step of benchmarkCase.steps) {
      metrics.push(await measureStep(view, step));
    }
    return {
      bytes: new Blob([view.state.doc.toString()]).size,
      group: benchmarkCase.group,
      id: benchmarkCase.id,
      label: benchmarkCase.label,
      lines: view.state.doc.lines,
      metrics,
      stats: collectEditorStats(view),
    };
  } finally {
    session.host.remove();
  }
}

async function createBenchmarkSession(doc: string): Promise<BenchmarkSession> {
  let host = document.createElement("div");
  host.className = "typora-benchmark-host";

  let editor = document.createElement("typora-editor") as TyporaEditorElement;
  editor.value = doc;
  editor.setAttribute("autofocus", "");
  host.append(editor);
  document.body.append(host);
  return { editor, host };
}

async function measureColdRender(session: BenchmarkSession, label: string) {
  let start = performance.now();
  await session.editor.ready;
  let view = benchmarkView(session);
  forceFullParse(view);
  await nextFrame();
  readLayout(view);
  return metric(`${label}: load, parse, and layout`, [performance.now() - start]);
}

function benchmarkView(session: BenchmarkSession) {
  let { view } = session.editor;
  if (!view) throw new Error("Typora benchmark editor view is not mounted");
  return view;
}

async function measureStep(view: EditorView, step: BenchmarkStep) {
  let samples: number[] = [];
  for (let iteration = 0; iteration < step.iterations; iteration++) {
    let start = performance.now();
    await step.run(view, iteration);
    forceFullParse(view);
    await nextFrame();
    readLayout(view);
    samples.push(performance.now() - start);
  }
  return metric(step.label, samples);
}

function forceFullParse(view: EditorView) {
  ensureSyntaxTree(view.state, view.state.doc.length, 4_000);
}

function readLayout(view: EditorView) {
  let rect = view.dom.getBoundingClientRect();
  layoutProbe += rect.height + rect.width + view.contentDOM.querySelectorAll(".cm-line").length;
}

function collectEditorStats(view: EditorView) {
  return {
    codeLines: view.dom.querySelectorAll(".cm-md-code-line").length,
    hiddenSyntax: view.dom.querySelectorAll(".cm-md-syntax-hidden").length,
    layoutProbe,
    renderedLines: view.contentDOM.querySelectorAll(".cm-line").length,
    tablePreviews: view.dom.querySelectorAll(".cm-md-table-preview").length,
    taskWidgets: view.dom.querySelectorAll(".cm-md-task-toggle").length,
  };
}

function typeIntoFirstParagraph(text: string) {
  let anchor: number | null = null;
  return (view: EditorView, iteration: number) => {
    if (anchor == null) {
      anchor = findNeedle(view, "The editor keeps Markdown") + "The editor keeps Markdown".length;
    }
    let insert = text.charAt(iteration % text.length);
    view.dispatch({
      changes: { from: anchor + iteration, insert },
      selection: { anchor: anchor + iteration + 1 },
      userEvent: "input.type",
    });
  };
}

function deleteLastBenchmarkBlock() {
  return (view: EditorView) => {
    let doc = view.state.doc.toString();
    let from = doc.lastIndexOf("\n## Delete Block ");
    if (from < 0) return;
    let next = doc.indexOf("\n## Delete Block ", from + 1);
    let to = next < 0 ? view.state.doc.length : next;
    view.dispatch({
      changes: { from, to },
      selection: { anchor: from },
      userEvent: "delete.selection",
    });
  };
}

function copyBenchmarkSection() {
  return (view: EditorView, iteration: number) => {
    let from = findNeedle(view, `## Benchmark Section ${(iteration % 8) + 1}`);
    let to = findSectionEnd(view, from);
    view.dispatch({
      selection: EditorSelection.range(from, to),
      userEvent: "select.copyBenchmark",
    });

    let copied = copyFromDom(view);
    clipboardBuffer = copied || view.state.sliceDoc(from, to);
  };
}

function pasteLargeBlock() {
  return (view: EditorView, iteration: number) => {
    let paste = clipboardBuffer || createInitialMarkdown();
    let insert = `\n\n<!-- pasted ${iteration} -->\n${paste}`;
    dispatchPaste(view, insert, view.state.doc.length);
  };
}

function pasteOverSelection() {
  return (view: EditorView, iteration: number) => {
    let from = findNeedle(view, "Paragraph ");
    let to = Math.min(view.state.doc.length, from + 160 + iteration);
    view.dispatch({ selection: EditorSelection.range(from, to) });
    dispatchPaste(view, `Replacement **markdown** ${iteration}\n\n> pasted quote\n`, from, to);
  };
}

function moveCursorAcrossDocument() {
  let anchors: number[] | null = null;
  return (view: EditorView, iteration: number) => {
    anchors ??= collectAnchors(view);
    let anchor = anchors[iteration % anchors.length] ?? 0;
    view.dispatch({
      selection: { anchor: clamp(anchor, 0, view.state.doc.length) },
      userEvent: "select.cursorBenchmark",
    });
  };
}

function expandSelectionRange() {
  let start: number | null = null;
  return (view: EditorView, iteration: number) => {
    start ??= findNeedle(view, "Paragraph 1");
    let head = clamp(start + 24 + iteration * 42, 0, view.state.doc.length);
    view.dispatch({
      selection: EditorSelection.range(start, head),
      userEvent: "select.rangeBenchmark",
    });
  };
}

function moveMultipleCursors() {
  let anchors: number[] | null = null;
  return (view: EditorView, iteration: number) => {
    anchors ??= collectAnchors(view);
    let ranges = anchors.slice(iteration % 5, (iteration % 5) + 8).map((anchor) => {
      return EditorSelection.cursor(clamp(anchor, 0, view.state.doc.length));
    });
    view.dispatch({
      selection: EditorSelection.create(ranges.length ? ranges : [EditorSelection.cursor(0)]),
      userEvent: "select.multiBenchmark",
    });
  };
}

function copyFromDom(view: EditorView) {
  if (typeof DataTransfer == "undefined" || typeof ClipboardEvent == "undefined") return "";
  let data = new DataTransfer();
  let event = new ClipboardEvent("copy", {
    bubbles: true,
    cancelable: true,
    clipboardData: data,
  });
  view.contentDOM.dispatchEvent(event);
  return data.getData("text/plain");
}

function dispatchPaste(view: EditorView, text: string, from: number, to = from) {
  view.dispatch({
    selection: EditorSelection.range(
      clamp(from, 0, view.state.doc.length),
      clamp(to, 0, view.state.doc.length),
    ),
  });

  let before = view.state.doc.length;
  if (typeof DataTransfer != "undefined" && typeof ClipboardEvent != "undefined") {
    let data = new DataTransfer();
    data.setData("text/plain", text);
    view.contentDOM.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }

  if (view.state.doc.length == before) {
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: "input.paste",
    });
  }
}

function collectAnchors(view: EditorView) {
  let doc = view.state.doc.toString();
  let anchors: number[] = [];
  for (let needle of ["## Benchmark Section", "- [ ]", "> Quote", "```ts", "| Column"]) {
    let from = 0;
    for (;;) {
      let index = doc.indexOf(needle, from);
      if (index < 0) break;
      anchors.push(index);
      from = index + needle.length;
    }
  }
  return anchors.sort((left, right) => left - right);
}

function findNeedle(view: EditorView, needle: string) {
  let found = view.state.doc.toString().indexOf(needle);
  return found < 0 ? 0 : found;
}

function findSectionEnd(view: EditorView, from: number) {
  let doc = view.state.doc.toString();
  let next = doc.indexOf("\n## Benchmark Section ", from + 1);
  return next < 0 ? Math.min(view.state.doc.length, from + 900) : next;
}

function scrollToRatio(view: EditorView, ratio: number) {
  let scroll = view.scrollDOM;
  scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * ratio;
}

function bounceRatio(iteration: number, count: number) {
  let midpoint = Math.max(1, Math.floor(count / 2));
  return iteration <= midpoint
    ? iteration / midpoint
    : 1 - (iteration - midpoint) / Math.max(1, count - midpoint - 1);
}

function metric(label: string, samples: number[]): TyporaBenchmarkMetric {
  let sorted = [...samples].sort((left, right) => left - right);
  return {
    avg: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    label,
    max: sorted.at(-1) ?? 0,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    samples,
    unit: "ms",
  };
}

function percentile(sorted: number[], ratio: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
}

function summarizeGroups(cases: TyporaBenchmarkCaseResult[]) {
  let groups: Record<string, { avg: number; max: number; p95: number }> = {};
  for (let group of [
    "render",
    "edit",
    "delete",
    "clipboard",
    "selection",
  ] satisfies BenchmarkGroup[]) {
    let metrics = cases
      .filter((result) => result.group == group)
      .flatMap((result) => result.metrics);
    let samples = metrics.flatMap((entry) => entry.samples);
    if (!samples.length) continue;
    groups[group] = {
      avg: samples.reduce((sum, value) => sum + value, 0) / samples.length,
      max: Math.max(...samples),
      p95: percentile(
        [...samples].sort((left, right) => left - right),
        0.95,
      ),
    };
  }
  return groups;
}

function buildBenchmarkMarkdown(sections: number) {
  let blocks = ["# Typora Benchmark Corpus", ""];
  for (let section = 1; section <= sections; section++) {
    blocks.push(
      `## Benchmark Section ${section}`,
      "",
      `Paragraph ${section} mixes **strong text**, _emphasis_, [links](https://example.com/${section}), and \`inline code\` so decoration work stays representative.`,
      "",
      `> Quote ${section} keeps nested Markdown active with **bold**, _italic_, and a [reference](https://codemirror.net/).`,
      "",
      `- [${section % 3 == 0 ? "x" : " "}] Task ${section}`,
      `- Bullet ${section}`,
      `  - Nested bullet ${section}`,
      "",
      "| Column | Value | State |",
      "| --- | ---: | :--- |",
      `| Row ${section} | ${section * 7} | active |`,
      "",
      "```ts",
      `export function benchmark${section}(value: number) {`,
      `  const result = value + ${section};`,
      "  return result.toString();",
      "}",
      "```",
      "",
    );
  }
  return blocks.join("\n");
}

function buildDeleteBlockMarkdown(blocks: number) {
  let chunks = ["# Delete Benchmark", ""];
  for (let index = 1; index <= blocks; index++) {
    chunks.push(
      `## Delete Block ${index}`,
      "",
      `Paragraph ${index} before deleting a selected Markdown block with **inline formatting**.`,
      "",
      "- [ ] remove task",
      "- remove bullet",
      "",
      "```ts",
      `const deleteBlock${index} = ${index};`,
      "```",
      "",
    );
  }
  return chunks.join("\n");
}

function alphabetBlock(repeats: number) {
  return Array.from({ length: repeats }, () => "abcdefghijklmnopqrstuvwxyz").join("\n");
}

function mountBenchmarkPanel() {
  let panel = document.createElement("aside");
  panel.className = "typora-benchmark-panel";
  panel.dataset.benchmarkStatus = "idle";
  panel.innerHTML = `
    <div class="typora-benchmark-toolbar">
      <strong>Typora benchmark</strong>
      <div class="typora-benchmark-actions">
        <button type="button" data-benchmark-run>Run</button>
        <button type="button" data-benchmark-copy disabled>Copy JSON</button>
      </div>
    </div>
    <p>Idle</p>
    <pre></pre>
  `;
  document.body.append(panel);

  let runButton = panel.querySelector<HTMLButtonElement>("[data-benchmark-run]")!;
  let copyButton = panel.querySelector<HTMLButtonElement>("[data-benchmark-copy]")!;
  runButton.addEventListener("click", () => {
    void runPanelBenchmark(panel);
  });
  copyButton.addEventListener("click", () => {
    void copyBenchmarkJson(panel);
  });
  return panel;
}

async function runPanelBenchmark(panel: HTMLElement) {
  let runButton = panel.querySelector<HTMLButtonElement>("[data-benchmark-run]")!;
  let copyButton = panel.querySelector<HTMLButtonElement>("[data-benchmark-copy]")!;
  let status = panel.querySelector("p")!;
  let output = panel.querySelector("pre")!;
  panel.dataset.benchmarkStatus = "running";
  runButton.disabled = true;
  copyButton.disabled = true;
  output.textContent = "";
  status.textContent = "Running";
  try {
    let result = await runTyporaBenchmark({
      onCase(caseResult) {
        status.textContent = `Measured ${caseResult.label}`;
        output.textContent = renderBenchmarkSummary({
          ...emptyBenchmarkResult(),
          cases: [caseResult],
        });
      },
    });
    panel.dataset.benchmarkStatus = "finished";
    status.textContent = `Finished ${result.cases.length} cases in ${formatMs(result.totalMs)}`;
    output.textContent = renderBenchmarkSummary(result);
    copyButton.disabled = false;
  } catch (error) {
    panel.dataset.benchmarkStatus = "failed";
    status.textContent = "Failed";
    output.textContent = error instanceof Error ? error.stack || error.message : String(error);
  } finally {
    runButton.disabled = false;
  }
}

async function copyBenchmarkJson(panel: HTMLElement) {
  let result = lastBenchmarkResult;
  if (!result) return;

  let status = panel.querySelector("p")!;
  try {
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    status.textContent = `Copied JSON for ${result.cases.length} cases`;
  } catch {
    status.textContent = "JSON report is available in #typora-benchmark-result";
  }
}

function publishBenchmarkResult(result: TyporaBenchmarkResult) {
  let output = document.getElementById(benchmarkResultElementId);
  if (!output) {
    output = document.createElement("script");
    output.id = benchmarkResultElementId;
    output.setAttribute("type", "application/json");
    document.body.append(output);
  }
  output.textContent = JSON.stringify(result);
}

function emptyBenchmarkResult(): TyporaBenchmarkResult {
  return {
    cases: [],
    groups: {},
    startedAt: new Date().toISOString(),
    totalMs: 0,
    userAgent: navigator.userAgent,
  };
}

function renderBenchmarkSummary(result: TyporaBenchmarkResult) {
  let lines = result.cases.flatMap((caseResult) => {
    return [
      `${caseResult.group}/${caseResult.id}`,
      ...caseResult.metrics.map((entry) => {
        return `  ${entry.label}: avg ${formatMs(entry.avg)}, p95 ${formatMs(entry.p95)}, max ${formatMs(entry.max)}`;
      }),
    ];
  });
  if (result.totalMs) lines.unshift(`total: ${formatMs(result.totalMs)}`);
  return lines.join("\n");
}

function formatMs(value: number) {
  return `${value.toFixed(value >= 100 ? 0 : 2)}ms`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function nextFrame() {
  return Promise.resolve();
}

installTyporaBenchmark();
