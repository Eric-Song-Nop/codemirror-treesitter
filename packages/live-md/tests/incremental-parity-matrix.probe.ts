import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { describe, expect, it } from "vite-plus/test";
import { __testBuildLiveMdAnalysis, liveMdAnalysis } from "../src/core/decorations.js";
import {
  codeFenceLanguagesField,
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  setCodeFenceLanguages,
} from "../src/core/languages.js";

type MatrixCase = {
  codeFenceLanguages?: boolean;
  doc: string;
  name: string;
  selection?: string;
  transaction: (doc: string) => TransactionSpec;
};

describe("LiveMD incremental parity matrix", () => {
  it("matches full rebuild output across representative Markdown edits", async () => {
    for (let testCase of matrixCases) {
      let state = await markdownState(
        testCase.doc,
        selectionAnchor(testCase.doc, testCase.selection),
        testCase.codeFenceLanguages,
      );
      let next = state.update(testCase.transaction(testCase.doc)).state;
      let incremental = canonicalAnalysis(next);
      let full = canonicalAnalysis(next, __testBuildLiveMdAnalysis(next));

      expect(incremental, testCase.name).toEqual(full);
    }
  });
});

const matrixCases: readonly MatrixCase[] = [
  edit("heading text", "# Old\n\nnext\n", replaceFirst("Old", "New")),
  edit("heading marker", "# Old\n\nnext\n", insertAtFirst("#", "#")),
  edit("blockquote text", "> quote\n\nnext\n", replaceFirst("quote", "cited")),
  edit("blockquote marker deletion", "> quote\n\nnext\n", deleteFirst("> ")),
  edit("list item text", "- first\n- second\n", replaceFirst("second", "second!")),
  edit("list marker kind", "- first\n- second\n", replaceFirst("- second", "* second")),
  edit("task marker toggle", "- [ ] task\n", replaceFirst("[ ]", "[x]")),
  edit("paragraph gap insertion", "alpha\nbeta\n", insertAtFirst("beta", "\n")),
  edit("thematic break", "---\n\nnext\n", replaceFirst("---", "***")),
  edit("code fence content", "```ts\nlet x = 1;\n```\n", replaceFirst("x", "y")),
  edit("code fence language", "```ts\nlet x = 1;\n```\n", replaceFirst("ts", "js")),
  edit(
    "code fence closing delimiter deletion",
    "```ts\nlet x = 1;\n```\n\nnext\n",
    deleteFirst("```\n\nnext"),
  ),
  edit("mermaid content", "```mermaid\ngraph TD\nA-->B\n```\n", replaceFirst("TD", "LR")),
  edit("table body cell", "| A | B |\n| - | - |\n| c | d |\n", replaceFirst("c", "cc")),
  edit(
    "table delimiter alignment",
    "| A | B |\n| - | - |\n| c | d |\n",
    replaceFirst("| - | - |", "| - | --: |"),
  ),
  edit(
    "html block content",
    "<div>\ncontent\n</div>\n\nnext\n",
    replaceFirst("content", "updated"),
  ),
  edit("indented code content", "    one\n    two\n\nnext\n", replaceFirst("two", "dos")),
  edit(
    "link reference destination",
    "[id]: https://one.test\n\nnext\n",
    replaceFirst("one", "two"),
  ),
  edit("yaml metadata title", "---\ntitle: One\n---\n\nnext\n", replaceFirst("One", "Two")),
  edit("image destination", "![alt](one.png)\nnext\n", replaceFirst("one", "two")),
  edit("image alt", "![alt](one.png)\nnext\n", replaceFirst("alt", "label")),
  edit("whole image deletion", "![alt](one.png)\nnext\n", deleteFirst("![alt](one.png)")),
  edit("inline link text", "[text](one)\n", replaceFirst("text", "label")),
  edit("inline link destination", "[text](one)\n", replaceFirst("one", "two")),
  edit("uri autolink", "<https://one.test>\n", replaceFirst("one", "two")),
  edit("inline latex", "$x^2$ and text\n", replaceFirst("x", "y"), { selection: " and text" }),
  edit("display latex", "$$\nE = mc^2\n$$\n\nnext\n", replaceFirst("mc", "mv"), {
    selection: "next",
  }),
  edit("inline code", "`code` and text\n", replaceFirst("code", "span")),
  edit("strong text", "**bold** and text\n", replaceFirst("bold", "loud")),
  edit("emphasis delimiter deletion", "*em* and text\n", deleteFirst("*")),
  edit("strikethrough text", "~~gone~~ and text\n", replaceFirst("gone", "away")),
  edit(
    "code fence TypeScript same-shape highlight",
    "```ts\nlet foo = 1;\nlet bar = 2;\n```\n",
    replaceFirst("foo", "baz"),
    {
      codeFenceLanguages: true,
    },
  ),
  edit(
    "code fence TypeScript syntax spill",
    "```ts\nlet a = 1;\nlet b = 2;\n```\n",
    insertAtFirst("let a", "/* "),
    {
      codeFenceLanguages: true,
    },
  ),
  {
    name: "selection enters table row",
    doc: "| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n\nnext\n",
    selection: "next",
    transaction(doc) {
      return { selection: { anchor: doc.indexOf("alpha") } };
    },
  },
  {
    name: "selection leaves rendered latex",
    doc: "$$\nE = mc^2\n$$\n\nnext\n",
    selection: "E = mc",
    transaction(doc) {
      return { selection: { anchor: doc.indexOf("next") } };
    },
  },
];

function edit(
  name: string,
  doc: string,
  change: (doc: string) => NonNullable<TransactionSpec["changes"]>,
  options: Pick<MatrixCase, "codeFenceLanguages" | "selection"> = {},
): MatrixCase {
  return {
    ...options,
    doc,
    name,
    transaction: (doc) => ({ changes: change(doc) }),
  };
}

async function markdownState(doc: string, selection: number, codeFenceLanguages?: boolean) {
  let state = EditorState.create({
    doc,
    selection: { anchor: selection },
    extensions: [codeFenceLanguagesField, liveMdAnalysis, await loadMarkdownExtension()],
  });
  if (codeFenceLanguages) {
    state = state.update({
      effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()),
    }).state;
  }
  return state;
}

function replaceFirst(search: string, insert: string) {
  return (text: string) => {
    let from = text.indexOf(search);
    if (from < 0) throw new Error(`Missing text: ${search}`);
    return { from, to: from + search.length, insert };
  };
}

function insertAtFirst(search: string, insert: string) {
  return (text: string) => {
    let from = text.indexOf(search);
    if (from < 0) throw new Error(`Missing text: ${search}`);
    return { from, insert };
  };
}

function deleteFirst(search: string) {
  return replaceFirst(search, "");
}

function selectionAnchor(doc: string, search?: string) {
  if (!search) return 0;
  let anchor = doc.indexOf(search);
  if (anchor < 0) throw new Error(`Missing selection anchor: ${search}`);
  return anchor;
}

function canonicalAnalysis(state: EditorState, analysis = state.field(liveMdAnalysis)) {
  let decorations: Array<{ from: number; spec: unknown; to: number }> = [];
  analysis.decorations.between(0, state.doc.length, (from, to, value) => {
    decorations.push({ from, spec: canonicalDecorationSpec(value.spec), to });
  });
  decorations.sort(compareCanonicalRange);

  let atomicRanges: Array<{ from: number; to: number; value: string }> = [];
  analysis.atomicRanges.between(0, state.doc.length, (from, to, value) => {
    atomicRanges.push({ from, to, value: value.constructor.name });
  });
  atomicRanges.sort(compareCanonicalRange);

  return { atomicRanges, decorations };
}

function compareCanonicalRange(
  left: { from: number; spec?: unknown; to: number; value?: string },
  right: { from: number; spec?: unknown; to: number; value?: string },
) {
  return (
    left.from - right.from ||
    left.to - right.to ||
    JSON.stringify(left.spec ?? left.value).localeCompare(JSON.stringify(right.spec ?? right.value))
  );
}

function canonicalDecorationSpec(spec: Decoration["spec"]) {
  let widget = spec.widget;
  if (widget && typeof widget == "object") {
    return {
      ...spec,
      widget: {
        name: widget.constructor.name,
        props: Object.fromEntries(
          Object.getOwnPropertyNames(widget)
            .sort()
            .map((name) => [name, (widget as unknown as Record<string, unknown>)[name]]),
        ),
      },
    };
  }
  return spec;
}
