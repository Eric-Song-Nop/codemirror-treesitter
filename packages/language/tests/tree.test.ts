import { Compartment, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  ParseContext,
  Language,
  NodeProp,
  NodeType,
  TreeSitterLanguage,
  TreeSitterParser,
  ensureSyntaxTree,
  languageDataProp,
  matchBrackets,
  queryTreeMatches,
  syntaxTreeChangedRanges,
  syntaxTree,
  syntaxTreeAvailable,
} from "../src/index.js";
import { __testResolveWasmPath } from "../src/language.js";
import { SyntaxNode } from "../src/tree.js";
import declarationMatchQuerySource from "./queries/declaration-match.scm?raw";
import type { Tree } from "../src/index.js";
import type { NodeIterator } from "../src/tree.js";

const javascriptWasm = new URL(
  "../../../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
  import.meta.url,
).pathname;
const htmlWasm = new URL(
  "../../../node_modules/tree-sitter-html/tree-sitter-html.wasm",
  import.meta.url,
).pathname;

let javascriptParser: Promise<TreeSitterParser> | null = null;
let htmlParser: Promise<TreeSitterParser> | null = null;

async function javascriptState(doc: string) {
  javascriptParser ??= TreeSitterParser.load(javascriptWasm);
  let parser = await javascriptParser;
  let language = TreeSitterLanguage.define({ name: "javascript", parser });
  return EditorState.create({ doc, extensions: [language.extension] });
}

function stackNames(state: EditorState, pos: number) {
  let names: string[] = [];
  for (let cur: NodeIterator | null = syntaxTree(state).resolveStack(pos); cur; cur = cur.next) {
    names.push(cur.node.name);
  }
  return names;
}

async function mixedHtmlState(doc: string) {
  javascriptParser ??= TreeSitterParser.load(javascriptWasm);
  htmlParser ??= TreeSitterParser.load(htmlWasm);
  let [jsParser, baseHtmlParser] = await Promise.all([javascriptParser, htmlParser]);
  let javascript = TreeSitterLanguage.define({
    name: "javascript",
    parser: jsParser,
    languageData: { mode: "javascript" },
  });
  let html = TreeSitterLanguage.define({
    name: "html",
    parser: baseHtmlParser,
    languageData: { mode: "html" },
    nested: [
      {
        parser: javascript.parser,
        ranges: scriptTextRanges,
      },
    ],
  });
  let state = EditorState.create({ doc, extensions: [html.extension] });
  return { state, html, javascript };
}

async function deferredMixedHtmlState(doc: string) {
  javascriptParser ??= TreeSitterParser.load(javascriptWasm);
  htmlParser ??= TreeSitterParser.load(htmlWasm);
  let [jsParser, baseHtmlParser] = await Promise.all([javascriptParser, htmlParser]);
  let sawContext = false;
  let skippedRange: { from: number; to: number } | null = null;
  let javascript = TreeSitterLanguage.define({
    name: "javascript",
    parser: jsParser,
    languageData: { mode: "javascript" },
  });
  let html = TreeSitterLanguage.define({
    name: "html",
    parser: baseHtmlParser,
    languageData: { mode: "html" },
    nested: [
      {
        parser: javascript.parser,
        ranges(tree) {
          let cx = ParseContext.get();
          sawContext ||= !!cx;
          return scriptTextRanges(tree).filter((range) => {
            if (cx && (range.from >= cx.viewport.to || range.to <= cx.viewport.from)) {
              skippedRange = range;
              cx.skipUntilInView(range.from, range.to);
              return false;
            }
            return true;
          });
        },
      },
    ],
  });
  let state = EditorState.create({ doc, extensions: [html.extension] });
  return { state, javascript, sawContext: () => sawContext, skippedRange: () => skippedRange };
}

async function asyncNestedMixedHtmlState(doc: string) {
  javascriptParser ??= TreeSitterParser.load(javascriptWasm);
  htmlParser ??= TreeSitterParser.load(htmlWasm);
  let [jsParser, baseHtmlParser] = await Promise.all([javascriptParser, htmlParser]);
  let loaded = false;
  let resolveLoaded!: () => void;
  let loadedPromise = new Promise<void>((resolve) => {
    resolveLoaded = () => {
      loaded = true;
      resolve();
    };
  });
  let javascript = TreeSitterLanguage.define({
    name: "javascript",
    parser: jsParser,
    languageData: { mode: "javascript" },
  });
  let html = TreeSitterLanguage.define({
    name: "html",
    parser: baseHtmlParser,
    languageData: { mode: "html" },
    nested: [
      {
        parser: () => (loaded ? javascript.parser : ParseContext.getSkippingParser(loadedPromise)),
        ranges: scriptTextRanges,
      },
    ],
  });
  let state = EditorState.create({ doc, extensions: [html.extension] });
  return { state, javascript, resolveLoaded };
}

function scriptTextRanges(tree: Tree) {
  let ranges: { from: number; to: number }[] = [];
  tree.iterate({
    enter(node) {
      if (node.name == "raw_text" && node.parent?.name == "script_element") {
        ranges.push({ from: node.from, to: node.to });
      }
    },
  });
  return ranges;
}

describe("tree-sitter tree wrapper", () => {
  it("returns grouped query matches with directive properties", async () => {
    let doc = "let answer = 42;";
    let state = await javascriptState(doc);
    ensureSyntaxTree(state, doc.length, 5_000);

    let matches = queryTreeMatches(syntaxTree(state), declarationMatchQuerySource, {
      includeNested: false,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]!.setProperties?.["declaration.kind"]).toBe("local");
    expect(matches[0]!.captures.map((capture) => capture.name)).toEqual([
      "declaration",
      "declaration.name",
      "declaration.value",
    ]);
    expect(
      state.sliceDoc(matches[0]!.captures[1]!.node.from, matches[0]!.captures[1]!.node.to),
    ).toBe("answer");
  });

  it("keeps Vite file URLs intact in browsers and resolves them for Node", () => {
    let viteUrl = "/@fs/Users/example/project/node_modules/tree-sitter-x/tree-sitter-x.wasm";
    expect(__testResolveWasmPath(viteUrl)).toBe(
      "/Users/example/project/node_modules/tree-sitter-x/tree-sitter-x.wasm",
    );
    let cwd = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process.cwd();
    let workspaceRoot = cwd.replace(/\/(?:packages|apps)\/[^/]+$/, "");
    expect(__testResolveWasmPath("/packages/language-data/src/wasm/tree-sitter-sql.wasm")).toBe(
      `${workspaceRoot}/packages/language-data/src/wasm/tree-sitter-sql.wasm`,
    );
    expect(__testResolveWasmPath("/src/wasm/tree-sitter-sql.wasm")).toBe(
      `${cwd}/src/wasm/tree-sitter-sql.wasm`,
    );

    let globals = globalThis as typeof globalThis & {
      document?: unknown;
      location?: unknown;
    };
    let documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    let locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
    try {
      Object.defineProperty(globals, "document", {
        configurable: true,
        value: {},
      });
      Object.defineProperty(globals, "location", {
        configurable: true,
        value: new URL("http://127.0.0.1:5173/"),
      });
      expect(__testResolveWasmPath(viteUrl)).toBe(viteUrl);
    } finally {
      if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
      else Reflect.deleteProperty(globals, "document");
      if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
      else Reflect.deleteProperty(globals, "location");
    }
  });

  it("resolves node stacks from the innermost syntax node to the root", async () => {
    let doc = "function f() {\n  return [1, (2 + 3)];\n}\n";
    let state = await javascriptState(doc);
    let names = stackNames(state, doc.indexOf("2"));

    expect(names.slice(0, 5)).toEqual([
      "number",
      "binary_expression",
      "parenthesized_expression",
      "array",
      "return_statement",
    ]);
    expect(names.at(-1)).toBe("program");
  });

  it("exposes tree-sitter field names and field-based child lookup", async () => {
    let doc = "function f() {\n  return left + 1;\n}\n";
    let state = await javascriptState(doc);
    let tree = syntaxTree(state);
    let functionName = tree.resolveInner(doc.indexOf("f()"));
    let functionNode = functionName.parent!;
    let binaryNode = tree.resolveInner(doc.indexOf("+")).parent!;

    expect(functionName.name).toBe("identifier");
    expect(functionName.fieldName).toBe("name");
    expect(functionName.matchContext(["program", "function_declaration"])).toBe(true);
    expect(functionName.matchContext(["program", "statement_block"])).toBe(false);
    expect(functionNode.childForFieldName("name")?.text).toBe("f");
    expect(functionNode.getChild("name")?.text).toBe("f");
    expect(functionNode.childrenForFieldName("body").map((node) => node.name)).toEqual([
      "statement_block",
    ]);
    expect(functionNode.getChildren("body").map((node) => node.name)).toEqual(["statement_block"]);
    expect(functionNode.getChild("formal_parameters")?.name).toBe("formal_parameters");
    expect(functionNode.getChild("statement_block", "formal_parameters")?.name).toBe(
      "statement_block",
    );
    expect(functionNode.getChild("identifier", "formal_parameters")).toBe(null);
    expect(functionNode.getChild("statement_block", null, "formal_parameters")).toBe(null);
    expect(functionNode.getChild("formal_parameters")?.prevSibling?.name).toBe("identifier");
    expect(binaryNode.name).toBe("binary_expression");
    expect(binaryNode.childForFieldName("left")?.text).toBe("left");
    expect(binaryNode.childForFieldName("right")?.text).toBe("1");
    expect(binaryNode.fieldNameForNamedChild(0)).toBe("left");
    expect(binaryNode.namedChildren.map((node) => node.fieldName)).toEqual(["left", "right"]);

    let cursor = functionNode.cursor()!;
    expect(cursor.childAfter(functionName.from)).toBe(true);
    expect(cursor.type.name).toBe("identifier");
    expect(cursor.name).toBe("identifier");
    expect(cursor.node.prop(languageDataProp)).toBeUndefined();
    expect(cursor.fieldName).toBe("name");
    expect(cursor.nodeIsNamed).toBe(true);
    expect(cursor.nodeText).toBe("f");

    expect(functionNode.getChild("formal_parameters")?.firstChild?.prop(NodeProp.closedBy)).toEqual(
      [")"],
    );
  });

  it("exposes tree-sitter node status and descendant helpers", async () => {
    let doc = "let alpha = beta + gamma;\n";
    let state = await javascriptState(doc);
    let tree = syntaxTree(state);
    let top = tree.topNode;
    let beta = doc.indexOf("beta");
    let gammaEnd = doc.indexOf("gamma") + "gamma".length;

    expect(top.type.is("program")).toBe(true);
    expect(top.isNamed).toBe(true);
    expect(tree.toString()).toContain("program");
    expect(top.childCount).toBe(1);
    expect(top.namedChildCount).toBe(1);
    expect(top.descendantCount).toBeGreaterThan(top.childCount);
    expect(top.hasError).toBe(false);
    expect(top.hasChanges).toBe(false);
    expect(top.parseState).toBeGreaterThanOrEqual(0);
    expect(top.nextParseState).toBeGreaterThanOrEqual(0);

    let identifiers = top.descendantsOfType("identifier");
    expect(identifiers.map((node) => node.text)).toEqual(["alpha", "beta", "gamma"]);
    expect(top.descendantsOfType("identifier", beta, gammaEnd).map((node) => node.text)).toEqual([
      "beta",
      "gamma",
    ]);

    let betaNode = top.descendantForIndex(beta)!;
    expect(betaNode.name).toBe("identifier");
    expect(betaNode.equals(top.namedDescendantForIndex(beta)!)).toBe(true);
    expect(top.namedDescendantForIndex(doc.indexOf("+"))?.name).toBe("binary_expression");
    expect(top.childWithDescendant(betaNode)?.name).toBe("lexical_declaration");
    expect(top.descendantForPosition(betaNode.startPosition)?.text).toBe("beta");
    expect(top.toString()).toContain("program");
  });

  it("supports Lezer-style node type helpers", () => {
    let expression = NodeType.define({
      id: 100,
      name: "binary_expression",
      props: [NodeProp.group.add({ binary_expression: ["Expression"] })],
    });

    expect(NodeType.none.is("")).toBe(true);
    expect(expression.is("binary_expression")).toBe(true);
    expect(expression.is("Expression")).toBe(true);
    expect(NodeType.match({ Expression: "group" })(expression)).toBe("group");
    expect(expression.isAnonymous).toBe(false);
  });

  it("exposes cursor movement, copy, and direct tree cursor access", async () => {
    let doc = "let alpha = beta + gamma;\n";
    let state = await javascriptState(doc);
    let tree = syntaxTree(state);
    let cursor = tree.cursor()!;
    let beta = doc.indexOf("beta");

    expect(cursor.name).toBe("program");
    expect(cursor.nodeType).toBe("program");
    expect(cursor.depth).toBe(0);
    expect(cursor.nodeIsNamed).toBe(true);
    expect(cursor.firstChild()).toBe(true);
    expect(cursor.name).toBe("lexical_declaration");
    expect(cursor.depth).toBe(1);
    expect(cursor.nodeText).toBe(doc.trim());
    expect(cursor.firstChildForIndex(beta)).toBe(true);
    expect(cursor.name).toBe("variable_declarator");
    expect(cursor.nodeText).toBe("alpha = beta + gamma");

    let copy = cursor.copy();
    expect(copy.nodeId).toBe(cursor.nodeId);
    expect(copy.descendantIndex).toBe(cursor.descendantIndex);
    expect(cursor.firstChild()).toBe(true);
    expect(cursor.name).toBe("identifier");
    expect(cursor.parent()).toBe(true);
    expect(cursor.name).toBe("variable_declarator");
    expect(cursor.next()).toBe(true);
    expect(cursor.name).toBe("identifier");

    let atBeta = tree.cursorAt(beta)!;
    expect(atBeta.name).toBe("identifier");
    expect(
      atBeta.matchContext([
        "program",
        "lexical_declaration",
        "variable_declarator",
        "binary_expression",
      ]),
    ).toBe(true);

    let direct = tree.cursor()!;
    expect(direct.enter(beta)).toBe(true);
    expect(direct.name).toBe("lexical_declaration");
    let identifiers: string[] = [];
    direct.iterate((node) => {
      if (node.name == "identifier") identifiers.push(node.text);
    });
    expect(identifiers).toEqual(["alpha", "beta", "gamma"]);
    direct.moveTo(beta);
    expect(direct.name).toBe("identifier");
    expect(direct.prev()).toBe(true);

    cursor.resetTo(copy);
    expect(cursor.name).toBe("variable_declarator");
    cursor.gotoDescendant(cursor.descendantIndex + 1);
    expect(cursor.name).toBe("identifier");
    copy.delete();
  });

  it("surfaces tree-sitter error state", async () => {
    let state = await javascriptState("let broken = ;\n");
    let top = syntaxTree(state).topNode;
    let errorNode = top.descendantsOfType("ERROR")[0];

    expect(top.hasError).toBe(true);
    expect(errorNode?.isError).toBe(true);
    expect(errorNode?.hasError).toBe(true);
  });

  it("positions cursors on direct children around a boundary", async () => {
    let doc = "let value = [1, (2 + 3)];\n";
    let state = await javascriptState(doc);
    let tree = syntaxTree(state);
    let arrayStart = doc.indexOf("[");
    let array = tree.resolveInner(arrayStart, 1).parent!;
    let cursor = array.cursor()!;

    expect(cursor.childBefore(arrayStart + 1)).toBe(true);
    expect(cursor.type.name).toBe("[");

    cursor = array.cursor()!;
    expect(cursor.childAfter(arrayStart + 1)).toBe(true);
    expect(cursor.type.name).toBe("number");
  });

  it("matches tree-sitter delimiter nodes across nested bracket pairs", async () => {
    let doc = "let value = [1, (2 + 3)];\n";
    let state = await javascriptState(doc);
    let arrayStart = doc.indexOf("[");
    let arrayEnd = doc.indexOf("]");
    let parenStart = doc.indexOf("(2");
    let parenEnd = doc.indexOf(")", parenStart);

    expect(matchBrackets(state, arrayStart, 1)).toEqual({
      start: { from: arrayStart, to: arrayStart + 1 },
      end: { from: arrayEnd, to: arrayEnd + 1 },
      matched: true,
    });
    expect(matchBrackets(state, parenEnd + 1, -1)).toEqual({
      start: { from: parenEnd, to: parenEnd + 1 },
      end: { from: parenStart, to: parenStart + 1 },
      matched: true,
    });
  });

  it("parses configured nested ranges with tree-sitter included ranges", async () => {
    let doc = "<main><script>let value = 1;</script><p>text</p></main>";
    let scriptFrom = doc.indexOf("let");
    let scriptTo = doc.indexOf("</script>");
    let value = doc.indexOf("value");
    let { state, html, javascript } = await mixedHtmlState(doc);

    expect(syntaxTree(state).resolveInner(value).name).toBe("identifier");
    expect(syntaxTree(state).prop(languageDataProp)).toBe(html.data);
    expect(state.languageDataAt("mode", value)).toEqual(["javascript"]);
    expect(state.languageDataAt("mode", doc.indexOf("main"))).toEqual(["html"]);
    expect(html.isActiveAt(state, value)).toBe(false);
    expect(javascript.isActiveAt(state, value)).toBe(true);
    expect(javascript.findRegions(state)).toEqual([{ from: scriptFrom, to: scriptTo }]);
  });

  it("includes outer ancestors when resolving stacks inside nested trees", async () => {
    let doc = "<main><script>let value = 1;</script><p>text</p></main>";
    let value = doc.indexOf("value");
    let { state } = await mixedHtmlState(doc);
    let names = stackNames(state, value);

    expect(names.slice(0, 4)).toEqual([
      "identifier",
      "variable_declarator",
      "lexical_declaration",
      "program",
    ]);
    expect(names.indexOf("raw_text")).toBeGreaterThan(names.indexOf("program"));
    expect(names.indexOf("script_element")).toBeGreaterThan(names.indexOf("raw_text"));
    expect(names.at(-1)).toBe("document");
  });

  it("exposes parse context for viewport-deferred nested ranges", async () => {
    let prefix = `<main><p>${"x".repeat(3_400)}</p>`;
    let script = "<script>let delayed = true;</script>";
    let doc = `${prefix}${script}</main>`;
    let delayed = doc.indexOf("delayed");
    let scriptFrom = doc.indexOf("let delayed");
    let scriptTo = doc.indexOf("</script>");
    let { state, javascript, sawContext, skippedRange } = await deferredMixedHtmlState(doc);

    expect(sawContext()).toBe(true);
    expect(skippedRange()).toEqual({ from: scriptFrom, to: scriptTo });
    expect(syntaxTree(state).resolveInner(delayed).name).not.toBe("identifier");
    expect(javascript.isActiveAt(state, delayed)).toBe(false);

    let tree = ensureSyntaxTree(state, scriptTo, 5_000)!;
    expect(tree.resolveInner(delayed).name).toBe("identifier");
    expect(tree.nestedAt(delayed)?.topNode.type.prop(languageDataProp)).toBe(javascript.data);
  });

  it("supports async nested tree-sitter parsers through skipping parsers", async () => {
    let doc = "<main><script>let delayed = true;</script></main>";
    let delayed = doc.indexOf("delayed");
    let scriptTo = doc.indexOf("</script>");
    let { state, javascript, resolveLoaded } = await asyncNestedMixedHtmlState(doc);

    expect(syntaxTree(state).resolveInner(delayed).name).not.toBe("identifier");
    expect(syntaxTreeAvailable(state, scriptTo)).toBe(false);
    expect(ensureSyntaxTree(state, scriptTo, 100)).toBe(null);

    resolveLoaded();
    await Promise.resolve();

    let tree = ensureSyntaxTree(state, scriptTo, 5_000)!;
    expect(tree.resolveInner(delayed).name).toBe("identifier");
    expect(tree.nestedAt(delayed)?.topNode.type.prop(languageDataProp)).toBe(javascript.data);
    expect(syntaxTreeAvailable(state, scriptTo)).toBe(true);
  });

  it("passes edited old nested trees back into tree-sitter", async () => {
    let doc = "<main><script>let value = 1;</script></main>";
    let { state } = await mixedHtmlState(doc);
    let before = syntaxTree(state).resolveInner(doc.indexOf("value"));
    let inserted = "<!-- heading -->";
    let tr = state.update({ changes: { from: 0, insert: inserted } });
    let after = syntaxTree(tr.state).resolveInner(doc.indexOf("value") + inserted.length);

    expect(after.name).toBe("identifier");
    expect(after.node?.id).toBe(before.node?.id);
  });

  it("edits old tree-sitter trees across multi-line changed ranges", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    let parser = await javascriptParser;
    let language = TreeSitterLanguage.define({ name: "javascript", parser });
    let doc = "let first = 1;\nlet middle = 2;\nlet last = 3;\n";
    let state = EditorState.create({ doc, extensions: [language.extension] });
    let oldTree = syntaxTree(state).tree!;
    let beforeMiddle = syntaxTree(state).resolveInner(doc.indexOf("middle"));
    let tr = state.update({
      changes: [
        { from: doc.indexOf("1"), to: doc.indexOf("1") + 1, insert: "10;\nlet inserted = 11" },
        { from: doc.indexOf("3"), to: doc.indexOf("3") + 1, insert: "30" },
      ],
    });
    let newDoc = tr.state.doc.toString();
    let editedOldTree = parser.editTree(oldTree, tr.changes, state.doc, tr.state.doc);
    let newTree = syntaxTree(tr.state).tree!;
    let changed = editedOldTree.getChangedRanges(newTree);
    let middleFrom = newDoc.indexOf("middle");
    let middleTo = middleFrom + "middle".length;
    let afterMiddle = syntaxTree(tr.state).resolveInner(middleFrom);

    expect(newDoc).toBe("let first = 10;\nlet inserted = 11;\nlet middle = 2;\nlet last = 30;\n");
    expect(afterMiddle.node?.id).toBe(beforeMiddle.node?.id);
    expect(
      changed.some((range) => range.startIndex < middleTo && range.endIndex > middleFrom),
    ).toBe(false);
  });

  it("reports syntax changed ranges separately from same-shape text edits", async () => {
    let state = await javascriptState("let foo = 1;\n");
    let rename = state.update({
      changes: { from: 4, to: 7, insert: "bar" },
    });
    let structural = state.update({
      changes: { from: 4, to: 7, insert: "function f() {}" },
    });

    expect(syntaxTreeChangedRanges(rename)).toEqual([]);
    expect(syntaxTreeChangedRanges(structural)).toEqual([{ from: 0, to: 24 }]);
  });

  it("caches syntax changed ranges per transaction", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    let parser = await javascriptParser;
    let language = TreeSitterLanguage.define({ name: "javascript", parser });
    let editCalls = 0;
    let originalEditWrappedTree = language.parser.editWrappedTree.bind(language.parser);

    Object.defineProperty(language.parser, "editWrappedTree", {
      configurable: true,
      value: (...args: Parameters<TreeSitterParser["editWrappedTree"]>) => {
        editCalls++;
        return originalEditWrappedTree(...args);
      },
    });
    try {
      let state = EditorState.create({
        doc: "let foo = 1;\n",
        extensions: [language.extension],
      });
      let transaction = state.update({
        changes: { from: 4, to: 7, insert: "function f() {}" },
      });
      syntaxTree(transaction.state);
      editCalls = 0;

      expect(syntaxTreeChangedRanges(transaction)).toEqual([{ from: 0, to: 24 }]);
      expect(syntaxTreeChangedRanges(transaction)).toEqual([{ from: 0, to: 24 }]);
      expect(editCalls).toBe(1);
    } finally {
      Object.defineProperty(language.parser, "editWrappedTree", {
        configurable: true,
        value: originalEditWrappedTree,
      });
    }
  });

  it("reports full syntax dirty ranges when parsing becomes available without text edits", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    let parser = await javascriptParser;
    let compartment = new Compartment();
    let javascript = TreeSitterLanguage.define({ name: "javascript", parser });
    let doc = "let value = 1;\n";
    let state = EditorState.create({ doc, extensions: [compartment.of([])] });
    let transaction = state.update({
      effects: compartment.reconfigure(javascript.extension),
    });

    expect(transaction.docChanged).toBe(false);
    expect(syntaxTreeChangedRanges(transaction)).toEqual([{ from: 0, to: doc.length }]);
  });

  it("does not materialize every sibling for ranged tree iteration", async () => {
    let doc = Array.from({ length: 80 }, (_, index) => `let value${index} = ${index};`).join("\n");
    let state = await javascriptState(doc);
    let from = doc.indexOf("value70");
    let to = from + "value70".length;
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
      syntaxTree(state).iterate({ from, to, enter: () => undefined });
    } finally {
      Object.defineProperty(SyntaxNode.prototype, "children", descriptor);
    }

    expect(materializedChildren).toBeLessThan(40);
  });

  it("parses and reuses multiple disjoint nested ranges", async () => {
    let doc =
      "<main><script>let first = 1;</script><p>text</p><script>let second = 2;</script></main>";
    let { state, javascript } = await mixedHtmlState(doc);
    let first = doc.indexOf("first");
    let second = doc.indexOf("second");
    let firstRange = { from: doc.indexOf("let first"), to: doc.indexOf("</script>") };
    let secondRange = {
      from: doc.indexOf("let second"),
      to: doc.indexOf("</script>", doc.indexOf("let second")),
    };
    let beforeSecond = syntaxTree(state).resolveInner(second);

    expect(syntaxTree(state).resolveInner(first).name).toBe("identifier");
    expect(beforeSecond.name).toBe("identifier");
    expect(javascript.findRegions(state)).toEqual([firstRange, secondRange]);

    let tr = state.update({ changes: { from: first, to: first + "first".length, insert: "one" } });
    let afterSecond = syntaxTree(tr.state).resolveInner(second - "first".length + "one".length);

    expect(afterSecond.name).toBe("identifier");
    expect(afterSecond.node?.id).toBe(beforeSecond.node?.id);
  });

  it("resumes interrupted nested tree-sitter parsing", async () => {
    let script = `${"let value = 1;\n".repeat(80_000)}let done = true;\n`;
    let doc = `<script>${script}</script>`;
    let { state } = await mixedHtmlState(doc);

    expect(ensureSyntaxTree(state, state.doc.length, 0)).toBe(null);
    expect(syntaxTreeAvailable(state)).toBe(false);

    let tree = ensureSyntaxTree(state, state.doc.length, 5_000);
    expect(tree?.resolveInner(doc.indexOf("done")).name).toBe("identifier");
    expect(syntaxTreeAvailable(state)).toBe(true);
  });

  it("lets parse work stop through a scheduler predicate and resume later", async () => {
    let doc = `${"let value = 1;\n".repeat(80_000)}let done = true;\n`;
    let state = await javascriptState(doc);
    let field = state.field(Language.state, false)!;

    expect(field.context.work(() => true)).toBe(false);
    expect(field.context.isDone(state.doc.length)).toBe(false);

    expect(field.context.work(5_000)).toBe(true);
    expect(field.context.tree.resolveInner(doc.indexOf("done")).name).toBe("identifier");
  });

  it("iterates nested trees in document order and respects range filters", async () => {
    let doc = "<main><script>let first = 1;</script><script>let second = 2;</script></main>";
    let { state } = await mixedHtmlState(doc);
    let tree = syntaxTree(state);
    let scriptText = doc.indexOf("let first");
    let scriptClose = doc.indexOf("</script>");
    let events: string[] = [];

    tree.iterate({
      enter(node) {
        if (
          (node.name == "raw_text" && node.from == scriptText) ||
          (node.name == "identifier" && node.text == "first") ||
          (node.name == "end_tag" && node.from == scriptClose)
        ) {
          events.push(node.name);
        }
      },
    });
    expect(events).toEqual(["raw_text", "identifier", "end_tag"]);

    let filtered: string[] = [];
    let second = doc.indexOf("second");
    tree.iterate({
      from: second,
      to: second + "second".length,
      enter(node) {
        if (node.name == "identifier") filtered.push(node.text);
      },
    });
    expect(filtered).toEqual(["second"]);
  });

  it("iterates nested nodes when a range starts before a later mounted range", async () => {
    let doc = "<main><script>let first = 1;</script><script>let second = 2;</script></main>";
    let { state } = await mixedHtmlState(doc);
    let tree = syntaxTree(state);
    let secondScript = doc.lastIndexOf("<script>");
    let second = doc.indexOf("second");
    let identifiers: string[] = [];

    tree.iterate({
      from: secondScript,
      to: second + "second".length,
      enter(node) {
        if (node.name == "identifier") identifiers.push(node.text);
      },
    });

    expect(identifiers).toEqual(["second"]);
  });

  it("supports balanced enter and leave traversal callbacks", async () => {
    let doc = "let value = [1, 2];\n";
    let state = await javascriptState(doc);
    let tree = syntaxTree(state);
    let events: string[] = [];

    tree.iterate({
      enter(node) {
        if (node.name == "array" || node.name == "number") events.push(`>${node.name}`);
        if (node.name == "number" && node.text == "1") return false;
      },
      leave(node) {
        if (node.name == "array" || node.name == "number") events.push(`<${node.name}`);
      },
    });

    expect(events).toEqual([">array", ">number", ">number", "<number", "<array"]);

    let array = tree.resolveInner(doc.indexOf("[")).parent!;
    let nodeEvents: string[] = [];
    array.iterate(
      (node) => {
        if (node.name == "array" || node.name == "number") nodeEvents.push(`>${node.name}`);
      },
      (node) => {
        if (node.name == "array" || node.name == "number") nodeEvents.push(`<${node.name}`);
      },
    );
    expect(nodeEvents).toEqual([">array", ">number", "<number", ">number", "<number", "<array"]);
  });
});
