import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  HighlightStyle,
  Tag,
  TreeSitterLanguage,
  TreeSitterParser,
  classHighlighter,
  highlightCode,
  highlightTree,
  highlightingFor,
  styleTags,
  syntaxHighlighters,
  syntaxHighlighting,
  syntaxTree,
  tagHighlighter,
  tags,
  type DocRange,
  type Tree,
} from "../src/index.js";
import { __testHighlightTree } from "../src/highlight.js";
import { tagsForCapture } from "../src/tags.js";
import { SyntaxNode } from "../src/tree.js";
import javascriptHighlights from "tree-sitter-javascript/queries/highlights.scm?raw";
import cssHighlights from "tree-sitter-css/queries/highlights.scm?raw";
import htmlHighlights from "tree-sitter-html/queries/highlights.scm?raw";

const javascriptWasm = new URL(
  "../../../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
  import.meta.url,
).pathname;
const cssWasm = new URL(
  "../../../node_modules/tree-sitter-css/tree-sitter-css.wasm",
  import.meta.url,
).pathname;
const htmlWasm = new URL(
  "../../../node_modules/tree-sitter-html/tree-sitter-html.wasm",
  import.meta.url,
).pathname;

let javascriptParser: Promise<TreeSitterParser> | null = null;
let cssParser: Promise<TreeSitterParser> | null = null;
let htmlParser: Promise<TreeSitterParser> | null = null;

async function languageState(doc: string, language: TreeSitterLanguage, highlight: HighlightStyle) {
  return EditorState.create({
    doc,
    extensions: [language.extension, syntaxHighlighting(highlight)],
  });
}

function scriptTextRanges(tree: Tree): DocRange[] {
  return rawTextRanges(tree, "script_element");
}

function styleTextRanges(tree: Tree): DocRange[] {
  return rawTextRanges(tree, "style_element");
}

function rawTextRanges(tree: Tree, parentName: string): DocRange[] {
  let ranges: DocRange[] = [];
  tree.iterate({
    enter(node) {
      if (node.name == "raw_text" && node.parent?.name == parentName) {
        ranges.push({ from: node.from, to: node.to });
      }
    },
  });
  return ranges;
}

describe("highlight tags", () => {
  it("exposes the active syntax highlighters for nested renderers", () => {
    let primary = tagHighlighter([{ tag: tags.keyword, class: "primary-keyword" }]);
    let fallback = tagHighlighter([{ tag: tags.keyword, class: "fallback-keyword" }]);
    let state = EditorState.create({
      extensions: [syntaxHighlighting(fallback, { fallback: true }), syntaxHighlighting(primary)],
    });

    expect(syntaxHighlighters(state)).toEqual([primary]);
  });

  it("returns fallback syntax highlighters when no primary highlighter is active", () => {
    let fallback = tagHighlighter([{ tag: tags.keyword, class: "fallback-keyword" }]);
    let state = EditorState.create({
      extensions: [syntaxHighlighting(fallback, { fallback: true })],
    });

    expect(syntaxHighlighters(state)).toEqual([fallback]);
  });

  it("falls back from specialized tags to their parent tags", () => {
    let highlighter = tagHighlighter([
      { tag: tags.comment, class: "comment" },
      { tag: tags.name, class: "name" },
      { tag: tags.number, class: "number" },
      { tag: tags.keyword, class: "keyword" },
      { tag: tags.operator, class: "operator" },
      { tag: tags.punctuation, class: "punctuation" },
      { tag: tags.heading, class: "heading" },
      { tag: tags.meta, class: "meta" },
    ]);

    expect(highlighter.style([tags.lineComment])).toBe("comment");
    expect(highlighter.style([tags.attributeName])).toBe("name");
    expect(highlighter.style([tags.integer])).toBe("number");
    expect(highlighter.style([tags.controlKeyword])).toBe("keyword");
    expect(highlighter.style([tags.compareOperator])).toBe("operator");
    expect(highlighter.style([tags.squareBracket])).toBe("punctuation");
    expect(highlighter.style([tags.heading3])).toBe("heading");
    expect(highlighter.style([tags.processingInstruction])).toBe("meta");
  });

  it("keeps modified tags stable and lets exact modified styles win", () => {
    let definition = tags.definition(tags.variableName);
    let localDefinition = tags.definition(tags.local(tags.variableName));

    expect(tags.definition(tags.variableName)).toBe(definition);
    expect(tags.definition(definition)).toBe(definition);
    expect(tags.local(tags.definition(tags.variableName))).toBe(localDefinition);
    expect(String(definition)).toBe("definition(variableName)");

    let base = tagHighlighter([{ tag: tags.variableName, class: "variable" }]);
    expect(base.style([definition])).toBe("variable");

    let specific = tagHighlighter([
      { tag: tags.variableName, class: "variable" },
      { tag: definition, class: "definition" },
    ]);
    expect(specific.style([definition])).toBe("definition");
  });

  it("exposes class highlighter mappings for parent and modified tags", () => {
    expect(classHighlighter.style([tags.blockComment])).toBe("tok-comment");
    expect(classHighlighter.style([tags.integer])).toBe("tok-number");
    expect(classHighlighter.style([tags.local(tags.variableName)])).toBe(
      "tok-variableName tok-local",
    );
  });

  it("allows local tags to derive from standard tags", () => {
    let custom = Tag.define("customName", tags.name);
    let highlighter = tagHighlighter([{ tag: tags.name, class: "name" }]);
    expect(highlighter.style([custom])).toBe("name");
  });

  it("maps common tree-sitter highlight captures to CodeMirror tags", () => {
    let highlighter = tagHighlighter([
      { tag: tags.atom, class: "atom" },
      { tag: tags.escape, class: "escape" },
      { tag: tags.function(tags.propertyName), class: "method" },
      { tag: tags.invalid, class: "invalid" },
      { tag: tags.standard(tags.typeName), class: "builtin-type" },
      { tag: tags.tagName, class: "tag" },
    ]);

    expect(highlighter.style(tagsForCapture("constant.builtin"))).toBe("atom");
    expect(highlighter.style(tagsForCapture("string.escape"))).toBe("escape");
    expect(highlighter.style(tagsForCapture("function.method"))).toBe("method");
    expect(highlighter.style(tagsForCapture("type.builtin"))).toBe("builtin-type");
    expect(highlighter.style(tagsForCapture("tag.error"))).toBe("tag invalid");
  });

  it("keeps language-scoped highlighters active for the matched language subtree", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    htmlParser ??= TreeSitterParser.load(htmlWasm);
    let javascript = TreeSitterLanguage.define({
      name: "javascript",
      parser: await javascriptParser,
    });
    let html = TreeSitterLanguage.define({
      name: "html",
      parser: await htmlParser,
    });
    let highlight = HighlightStyle.define([{ tag: tags.variableName, class: "scoped-var" }], {
      scope: javascript,
    });
    let jsDoc = "let value = 1;\n";
    let jsState = await languageState(jsDoc, javascript, highlight);
    let jsTree = syntaxTree(jsState);
    let spans = __testHighlightTree(jsTree, [highlight]);

    expect(spans).toContainEqual({
      from: jsDoc.indexOf("value"),
      to: jsDoc.indexOf("value") + "value".length,
      class: "scoped-var",
    });
    expect(highlightingFor(jsState, [tags.variableName], jsTree.topNode.type)).toBe("scoped-var");

    let htmlState = await languageState("<p>value</p>\n", html, highlight);
    expect(
      highlightingFor(htmlState, [tags.variableName], syntaxTree(htmlState).topNode.type),
    ).toBe(null);

    let nestedHtml = TreeSitterLanguage.define({
      name: "html",
      parser: await htmlParser,
      nested: [{ parser: javascript.parser, ranges: scriptTextRanges }],
    });
    let htmlHighlight = HighlightStyle.define([{ tag: tags.variableName, class: "html-var" }], {
      scope: nestedHtml,
    });
    let mixedDoc = "<script>let value = 1;</script>\n";
    let mixedState = EditorState.create({
      doc: mixedDoc,
      extensions: [nestedHtml.extension],
    });
    let mixedValue = mixedDoc.indexOf("value");
    let mixedSpans = __testHighlightTree(syntaxTree(mixedState), [htmlHighlight, highlight]);

    expect(mixedSpans).toContainEqual({
      from: mixedValue,
      to: mixedValue + "value".length,
      class: "scoped-var",
    });
    expect(mixedSpans).not.toContainEqual({
      from: mixedValue,
      to: mixedValue + "value".length,
      class: "html-var scoped-var",
    });
  });

  it("uses tree-sitter highlight query captures before generic node-name tags", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    let javascript = TreeSitterLanguage.define({
      name: "javascript",
      parser: await javascriptParser,
      highlightQuery: javascriptHighlights,
    });
    let highlighter = tagHighlighter([
      { tag: tags.variableName, class: "var" },
      { tag: tags.function(tags.variableName), class: "fn" },
      { tag: tags.constant(tags.variableName), class: "const" },
    ]);
    let doc = "const MAX_VALUE = 1;\nfunction demo() {\n  console.log(MAX_VALUE);\n}\n";
    let state = EditorState.create({
      doc,
      extensions: [javascript.extension],
    });
    let spans = __testHighlightTree(syntaxTree(state), [highlighter]);
    let classAt = (text: string) =>
      spans.find(
        (span) => span.from == doc.indexOf(text) && span.to == doc.indexOf(text) + text.length,
      )?.class;

    expect(classAt("demo")).toContain("fn");
    expect(classAt("MAX_VALUE")).toContain("const");
  });

  it("does not materialize every sibling for ranged highlighting", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    let javascript = TreeSitterLanguage.define({
      name: "javascript",
      parser: await javascriptParser,
    });
    let doc = Array.from({ length: 80 }, (_, index) => `let value${index} = ${index};`).join("\n");
    let state = EditorState.create({ doc, extensions: [javascript.extension] });
    let from = doc.indexOf("value70");
    let to = from + "value70".length;
    let highlighter = tagHighlighter([{ tag: tags.variableName, class: "var" }]);
    let materializedChildren = 0;
    let descriptor = Object.getOwnPropertyDescriptor(SyntaxNode.prototype, "children")!;

    Object.defineProperty(SyntaxNode.prototype, "children", {
      configurable: true,
      get(this: SyntaxNode) {
        let children = descriptor.get!.call(this) as SyntaxNode[];
        materializedChildren += children.length;
        return children;
      },
    });
    try {
      __testHighlightTree(syntaxTree(state), [highlighter], from, to);
    } finally {
      Object.defineProperty(SyntaxNode.prototype, "children", descriptor);
    }

    expect(materializedChildren).toBeLessThan(40);
  });

  it("supports Lezer-compatible styleTags rules and code highlighting", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    let javascript = TreeSitterLanguage.define({
      name: "javascript",
      parser: await javascriptParser,
      props: [
        styleTags({
          "lexical_declaration/variable_declarator/identifier": tags.definition(tags.variableName),
          number: tags.number,
        }),
      ],
    });
    let highlighter = tagHighlighter([
      { tag: tags.definition(tags.variableName), class: "def" },
      { tag: tags.number, class: "num" },
    ]);
    let code = "let value = 1;\nvalue;\n";
    let tree = javascript.parser.parse(Text.of(code.split("\n")));
    let spans: { from: number; to: number; cls: string }[] = [];
    highlightTree(tree, highlighter, (from, to, cls) => spans.push({ from, to, cls }));

    expect(spans).toContainEqual({
      from: code.indexOf("value"),
      to: code.indexOf("value") + "value".length,
      cls: "def",
    });
    expect(spans).not.toContainEqual({
      from: code.lastIndexOf("value"),
      to: code.lastIndexOf("value") + "value".length,
      cls: "def",
    });

    let html = "";
    highlightCode(
      code,
      tree,
      highlighter,
      (text, cls) => {
        html += cls ? `<${cls}>${text}</${cls}>` : text;
      },
      () => {
        html += "<br>";
      },
    );
    expect(html).toContain("<def>value</def>");
    expect(html).toContain("<num>1</num>");
    expect(html).toContain("<br>");
  });

  it("highlights host HTML after nested CSS and JavaScript ranges", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    cssParser ??= TreeSitterParser.load(cssWasm);
    htmlParser ??= TreeSitterParser.load(htmlWasm);
    let javascript = TreeSitterLanguage.define({
      name: "javascript",
      parser: await javascriptParser,
      highlightQuery: javascriptHighlights,
    });
    let css = TreeSitterLanguage.define({
      name: "css",
      parser: await cssParser,
      highlightQuery: cssHighlights,
      styleTags: { plain_value: tags.atom },
    });
    let html = TreeSitterLanguage.define({
      name: "html",
      parser: await htmlParser,
      highlightQuery: htmlHighlights,
      nested: [
        { parser: css.parser, ranges: styleTextRanges },
        { parser: javascript.parser, ranges: scriptTextRanges },
      ],
    });
    let highlighter = tagHighlighter([
      { tag: tags.tagName, class: "tag" },
      { tag: tags.keyword, class: "keyword" },
      { tag: tags.atom, class: "atom" },
      { tag: tags.string, class: "string" },
    ]);
    let doc = `<main>
  <style>
    main { display: grid; color: steelblue; }
  </style>
  <script>
    const message = "nested JavaScript";
  </script>
</main>
`;
    let state = EditorState.create({
      doc,
      extensions: [html.extension],
    });
    let spans = __testHighlightTree(syntaxTree(state), [highlighter]);
    let classAt = (text: string, start = doc.indexOf(text)) =>
      spans.find((span) => span.from == start && span.to == start + text.length)?.class;

    expect(classAt("style", doc.indexOf("style"))).toBe("tag");
    expect(classAt("grid")).toBe("atom");
    expect(classAt("const")).toBe("keyword");
    expect(classAt("script", doc.indexOf("</script>") + 2)).toBe("tag");
    expect(classAt("main", doc.indexOf("</main>") + 2)).toBe("tag");
  });
});
