import { Tree, TreeSitterParser } from "@codemirror-treesitter/language";
import { describe, expect, it } from "vite-plus/test";
import { deleteLiveMdTree } from "../src/core/languages.js";
import * as renderCacheInternals from "../src/core/runtime/render-cache.js";
import type { Tree as NativeTree } from "web-tree-sitter";

function fakeNativeTree(label: string, deleted: string[]): NativeTree {
  return {
    rootNode: { id: label.length + 1 },
    delete() {
      deleted.push(label);
    },
  } as unknown as NativeTree;
}

describe("LiveMD tree resource lifetime", () => {
  it("deletes deeply nested wrapped trees iteratively and idempotently", () => {
    let deleted: string[] = [];
    let parser = TreeSitterParser.getSkippingParser();
    let depth = 12_000;
    let tree = new Tree(fakeNativeTree("0", deleted), parser, 1);
    for (let index = 1; index < depth; index++) {
      tree = new Tree(fakeNativeTree(String(index), deleted), parser, 1, [
        { parser, tree, ranges: [{ from: 0, to: 1 }] },
      ]);
    }

    expect(() => deleteLiveMdTree(tree)).not.toThrow();
    expect(() => deleteLiveMdTree(tree)).not.toThrow();
    expect(deleted).toHaveLength(depth);
  });

  it("keeps a reused native tree alive until every wrapper graph is deleted", () => {
    let deleted: string[] = [];
    let parser = TreeSitterParser.getSkippingParser();
    let nativeNested = fakeNativeTree("nested", deleted);
    let firstNested = new Tree(nativeNested, parser, 1);
    let secondNested = new Tree(nativeNested, parser, 1);
    let first = new Tree(fakeNativeTree("first", deleted), parser, 1, [
      { parser, tree: firstNested, ranges: [{ from: 0, to: 1 }] },
    ]);
    let second = new Tree(fakeNativeTree("second", deleted), parser, 1, [
      { parser, tree: secondNested, ranges: [{ from: 0, to: 1 }] },
    ]);

    deleteLiveMdTree(first);
    expect(deleted).toEqual(["first"]);

    deleteLiveMdTree(second);
    expect(deleted).toEqual(["first", "second", "nested"]);
  });

  it("counts deeply nested native trees without recursive stack growth", () => {
    let deleted: string[] = [];
    let parser = TreeSitterParser.getSkippingParser();
    let depth = 12_000;
    let tree = new Tree(fakeNativeTree("0", deleted), parser, 1);
    for (let index = 1; index < depth; index++) {
      tree = new Tree(fakeNativeTree(String(index), deleted), parser, 1, [
        { parser, tree, ranges: [{ from: 0, to: 1 }] },
      ]);
    }
    let count = (
      renderCacheInternals as typeof renderCacheInternals & {
        __testCountNativeTrees?(tree: Tree): number;
      }
    ).__testCountNativeTrees;

    expect(() => count?.(tree)).not.toThrow();
    expect(count?.(tree)).toBe(depth);
    tree.delete();
  });
});
