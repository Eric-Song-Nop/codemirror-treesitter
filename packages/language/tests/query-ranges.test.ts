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
