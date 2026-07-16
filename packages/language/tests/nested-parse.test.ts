import { Text } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { __testCreateNestedTreeMatcher, TreeSitterParser } from "../src/language.js";
import { Tree, type DocRange, type NestedTree } from "../src/tree.js";
import type { Parser as TSParser, Tree as TSTree } from "web-tree-sitter";

function nested(parser: TreeSitterParser, ranges: readonly DocRange[], marker: number): NestedTree {
  return {
    parser,
    ranges,
    tree: new Tree(null, parser, marker),
  };
}

describe("nested tree matching", () => {
  it("uses the matcher in the production nested wrapping path", () => {
    let nestedParser = TreeSitterParser.getSkippingParser();
    Object.defineProperties(nestedParser, {
      isSkippingParser: { value: false },
      createParser: {
        value: () => ({ delete() {}, reset() {} }) as TSParser,
      },
      parseWith: { value: () => ({}) as TSTree },
    });
    let ranges = [{ from: 0, to: 1 }];
    let outerParser = TreeSitterParser.getSkippingParser().configure({
      nested: [{ parser: nestedParser, ranges: () => [ranges] }],
    });
    let oldNested = [nested(nestedParser, ranges, 1)];
    Object.defineProperty(oldNested, "find", {
      value: () => {
        throw new Error("legacy linear Array.find path was used");
      },
    });
    let oldTree = new Tree({} as TSTree, outerParser, 1, oldNested);

    let result = outerParser.wrapTree({} as TSTree, Text.of(["x"]), oldTree);

    expect(result?.nested).toHaveLength(1);
    expect(result?.nested[0]?.ranges).toEqual(ranges);
  });

  it("takes exact duplicate range groups in FIFO order", () => {
    let parser = TreeSitterParser.getSkippingParser();
    let ranges = [{ from: 10, to: 20 }];
    let first = nested(parser, ranges, 1);
    let second = nested(parser, ranges, 2);
    let matcher = __testCreateNestedTreeMatcher([first, second]);

    expect(matcher.take(parser, ranges)).toBe(first);
    expect(matcher.take(parser, ranges)).toBe(second);
    expect(matcher.take(parser, ranges)).toBeNull();
  });

  it("isolates otherwise identical range groups by parser identity", () => {
    let javascript = TreeSitterParser.getSkippingParser();
    let css = TreeSitterParser.getSkippingParser();
    let ranges = [{ from: 10, to: 20 }];
    let javascriptTree = nested(javascript, ranges, 1);
    let cssTree = nested(css, ranges, 2);
    let matcher = __testCreateNestedTreeMatcher([javascriptTree, cssTree]);

    expect(matcher.take(css, ranges)).toBe(cssTree);
    expect(matcher.take(javascript, ranges)).toBe(javascriptTree);
  });

  it("does not treat the holes in a multi-range group as overlap", () => {
    let parser = TreeSitterParser.getSkippingParser();
    let withHole = nested(
      parser,
      [
        { from: 0, to: 10 },
        { from: 90, to: 100 },
      ],
      1,
    );
    let matcher = __testCreateNestedTreeMatcher([withHole]);

    expect(matcher.take(parser, [{ from: 40, to: 60 }])).toBeNull();
    expect(matcher.take(parser, [{ from: 5, to: 6 }])).toBe(withHole);
  });

  it("matches 10,000 exact groups with a deterministic linear operation bound", () => {
    let parser = TreeSitterParser.getSkippingParser();
    let count = 10_000;
    let oldNested = Array.from({ length: count }, (_, index) =>
      nested(parser, [{ from: index * 3, to: index * 3 + 1 }], index),
    );
    let matcher = __testCreateNestedTreeMatcher(oldNested);

    for (let index = 0; index < count; index++) {
      expect(matcher.take(parser, [{ from: index * 3, to: index * 3 + 1 }])).toBe(oldNested[index]);
    }

    expect(matcher.stats.indexedGroups).toBe(count);
    expect(matcher.stats.indexedRanges).toBe(count);
    expect(matcher.stats.exactLookups).toBe(count);
    expect(matcher.stats.intervalQueries).toBe(0);
    expect(matcher.stats.intervalNodeVisits).toBe(0);
    expect(matcher.stats.rangeComparisons).toBe(0);
    expect(
      matcher.stats.indexedGroups + matcher.stats.indexedRanges + matcher.stats.exactLookups,
    ).toBeLessThanOrEqual(count * 3);
  });
});
