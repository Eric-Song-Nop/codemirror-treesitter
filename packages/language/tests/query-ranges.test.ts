import { Text } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  queryNodeCaptures,
  queryNodeMatches,
  queryTreeCaptures,
  queryTreeMatches,
  TreeSitterParser,
} from "../src/index.js";
import { __testDisposeWrappedTree } from "../src/language.js";

const javascriptWasm = new URL(
  "../../../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
  import.meta.url,
).pathname;

const source =
  "const before = '😀';\nfunction run() {\n  const α = '漢字😀';\n  const target = 2;\n  const finalValue = 3;\n}\nconst after = 4;";
const query = "(identifier) @name";

describe("UTF-16 query ranges", () => {
  it("keeps a zero upper bound empty without changing nonzero point queries", async () => {
    let parser = await TreeSitterParser.load(javascriptWasm);
    let tree = parser.parse(Text.of(source.split("\n")));
    try {
      for (let options of [{ to: 0 }, { from: 0, to: 0 }]) {
        expect(queryTreeCaptures(tree, query, options)).toHaveLength(0);
        expect(queryTreeMatches(tree, query, options)).toHaveLength(0);
        expect(queryNodeCaptures(tree.topNode, query, options)).toHaveLength(0);
        expect(queryNodeMatches(tree.topNode, query, options)).toHaveLength(0);
      }
      let point = source.indexOf("target") + 2;
      let options = { from: point, to: point };
      expect(queryTreeCaptures(tree, query, options).map((capture) => capture.node.text)).toEqual([
        "target",
      ]);
      expect(
        queryNodeCaptures(tree.topNode, query, options).map((capture) => capture.node.text),
      ).toEqual(["target"]);
      expect(
        queryTreeMatches(tree, query, options).flatMap((match) =>
          match.captures.map((capture) => capture.node.text),
        ),
      ).toEqual(["target"]);
      expect(
        queryNodeMatches(tree.topNode, query, options).flatMap((match) =>
          match.captures.map((capture) => capture.node.text),
        ),
      ).toEqual(["target"]);
    } finally {
      __testDisposeWrappedTree(tree);
      parser.clearQueryCache();
    }
  });

  it.each(["tree", "node"])(
    "bounds %s captures and matches in document coordinates",
    async (kind) => {
      let parser = await TreeSitterParser.load(javascriptWasm);
      let tree = parser.parse(Text.of(source.split("\n")));
      try {
        let root = tree.topNode.getChild("function_declaration")!;
        expect(root.from).toBeGreaterThan(0);
        let from = source.indexOf("target");
        let to = from + "target".length;
        for (let [options, expected] of [
          [{ from, to }, ["target"]],
          [{ from }, kind == "tree" ? ["target", "finalValue", "after"] : ["target", "finalValue"]],
          [{ to }, kind == "tree" ? ["before", "run", "α", "target"] : ["run", "α", "target"]],
        ] as const) {
          let captures =
            kind == "tree"
              ? queryTreeCaptures(tree, query, options)
              : queryNodeCaptures(root, query, options);
          let matches =
            kind == "tree"
              ? queryTreeMatches(tree, query, options)
              : queryNodeMatches(root, query, options);
          expect(captures.map((capture) => capture.node.text)).toEqual(expected);
          expect(
            matches.flatMap((match) => match.captures.map((capture) => capture.node.text)),
          ).toEqual(expected);
          for (let capture of captures) {
            expect(source.slice(capture.node.from, capture.node.to)).toBe(capture.node.text);
          }
        }
      } finally {
        __testDisposeWrappedTree(tree);
        parser.clearQueryCache();
      }
    },
  );
});
