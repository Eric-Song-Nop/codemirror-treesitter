import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  Tree,
  TreeSitterLanguage,
  TreeSitterParser,
  syntaxTree,
  type SyntaxNode,
} from "../src/index.js";

const javascriptWasm = new URL(
  "../../../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
  import.meta.url,
).pathname;

let javascriptParser: Promise<TreeSitterParser> | null = null;

async function javascriptTree(doc: string) {
  javascriptParser ??= TreeSitterParser.load(javascriptWasm);
  let parser = await javascriptParser;
  let language = TreeSitterLanguage.define({ name: "javascript", parser });
  let state = EditorState.create({ doc, extensions: [language.extension] });
  return { parser, tree: syntaxTree(state) };
}

function captureTexts(captures: readonly { node: SyntaxNode }[]) {
  return captures.map((capture) => capture.node.text);
}

describe("tree-sitter query wrapper", () => {
  it("returns capture names, pattern indexes, and wrapped syntax nodes", async () => {
    let { parser, tree } = await javascriptTree("function demo(value) {\n  return value;\n}\n");
    let captures = parser
      .query(`
        (function_declaration name: (identifier) @function)
        (return_statement) @return
      `)
      .captures(tree);

    expect(captures.map((capture) => capture.name)).toEqual(["function", "return"]);
    expect(captures.map((capture) => capture.patternIndex)).toEqual([0, 1]);
    expect(captureTexts(captures)).toEqual(["demo", "return value;"]);
    expect(captures[0]!.node.tree).toBe(tree);
    expect(captures[0]!.node.name).toBe("identifier");
  });

  it("returns matches with pattern properties", async () => {
    let { parser, tree } = await javascriptTree("const alpha = 1;\nlet beta = alpha;\n");
    let matches = parser
      .query(`
        ((lexical_declaration) @declaration
          (#set! live-md.owner "declaration"))
      `)
      .matches(tree);

    expect(matches).toHaveLength(2);
    expect(matches[0]!.setProperties).toEqual({ "live-md.owner": "declaration" });
    expect(matches[0]!.captures).toHaveLength(1);
    expect(matches[0]!.captures[0]!.name).toBe("declaration");
    expect(matches[0]!.captures[0]!.setProperties).toEqual({
      "live-md.owner": "declaration",
    });
  });

  it("queries a SyntaxNode target", async () => {
    let { parser, tree } = await javascriptTree("function demo(value) {\n  return value;\n}\n");
    let functionNode = tree.topNode.getChild("function_declaration")!;
    let captures = parser.query("(identifier) @identifier").captures(functionNode);

    expect(captureTexts(captures)).toEqual(["demo", "value", "value"]);
    expect(captures.every((capture) => capture.node.tree == tree)).toBe(true);
  });

  it("uses from/to as an intersecting query window", async () => {
    let doc = "function demo() {\n  let value = 1;\n  return value;\n}\n";
    let { parser, tree } = await javascriptTree(doc);
    let value = doc.indexOf("value");
    let captures = parser
      .query("(function_declaration) @function")
      .captures(tree, { from: value, to: value + 1 });

    expect(captureTexts(captures)).toEqual([doc.trimEnd()]);
  });

  it("uses containedFrom/containedTo as a fully-contained query window", async () => {
    let doc = "function demo() {\n  let value = 1;\n  return value;\n}\n";
    let { parser, tree } = await javascriptTree(doc);
    let value = doc.indexOf("value");
    let query = parser.query("(function_declaration) @function");

    expect(query.captures(tree, { containedFrom: value, containedTo: value + 1 })).toHaveLength(0);
    expect(
      query.captures(tree, { containedFrom: 0, containedTo: doc.trimEnd().length }),
    ).toHaveLength(1);
  });

  it("supports tree-sitter text predicates", async () => {
    let { parser, tree } = await javascriptTree("let alpha = beta + gamma;\n");
    let captures = parser
      .query(`
        ((identifier) @name
          (#eq? @name "beta"))
      `)
      .captures(tree);

    expect(captureTexts(captures)).toEqual(["beta"]);
  });

  it("returns no captures or matches for an empty tree", async () => {
    javascriptParser ??= TreeSitterParser.load(javascriptWasm);
    let parser = await javascriptParser;
    let query = parser.query("(program) @program");

    expect(query.captures(Tree.empty)).toEqual([]);
    expect(query.matches(Tree.empty)).toEqual([]);
  });

  it("throws when creating a query for a skipping parser", () => {
    expect(() => TreeSitterParser.getSkippingParser().query("(program) @program")).toThrow(
      /Skipping parsers can not create tree-sitter queries/,
    );
  });
});
