import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  Tree,
  TreeSitterLanguage,
  TreeSitterParser,
  compileTreeSitterQuery,
  matchBrackets,
  syntaxTree,
  syntaxTreeChangedRanges,
} from "../src/index.js";
import * as languageInternals from "../src/language.js";
import { SyntaxNode, TreeCursor } from "../src/tree.js";
import { Query as WebTreeSitterQuery } from "web-tree-sitter";
import type {
  Parser as NativeParser,
  Query as NativeQuery,
  Tree as NativeTree,
} from "web-tree-sitter";

const javascriptWasm = new URL(
  "../../../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
  import.meta.url,
).pathname;

async function javascriptState(doc: string) {
  let parser = await TreeSitterParser.load(javascriptWasm);
  let language = TreeSitterLanguage.define({ name: "javascript", parser });
  return EditorState.create({ doc, extensions: [language.extension] });
}

function countCreatedCursors(callback: () => void) {
  let cursorDescriptor = Object.getOwnPropertyDescriptor(SyntaxNode.prototype, "cursor")!;
  let originalCursor = cursorDescriptor.value as (this: SyntaxNode) => TreeCursor | null;
  let created = 0;
  let deleted = 0;
  SyntaxNode.prototype.cursor = function (this: SyntaxNode) {
    let cursor = originalCursor.call(this);
    if (!cursor) return cursor;
    created++;
    let originalDelete = cursor.delete.bind(cursor);
    let wasDeleted = false;
    cursor.delete = () => {
      if (!wasDeleted) {
        wasDeleted = true;
        deleted++;
      }
      originalDelete();
    };
    return cursor;
  };
  try {
    callback();
  } finally {
    Object.defineProperty(SyntaxNode.prototype, "cursor", cursorDescriptor);
  }
  return { created, deleted };
}

function fakeNativeTree(label: string, deleted: string[]): NativeTree {
  return {
    rootNode: { id: label.length + 1 },
    delete() {
      deleted.push(label);
    },
  } as unknown as NativeTree;
}

describe("native resource lifetime", () => {
  it("deletes getChildren cursors on every early-return path", async () => {
    let state = await javascriptState("function f(arg) { return arg; }\n");
    let functionNode = syntaxTree(state).topNode.firstNamedChild!;

    let counts = countCreatedCursors(() => {
      expect(functionNode.getChildren("statement_block", "formal_parameters")).toHaveLength(1);
      expect(functionNode.getChildren("missing", "also_missing")).toEqual([]);
      expect(functionNode.getChildren("identifier", null, "formal_parameters")).toHaveLength(1);
    });

    expect(counts.created).toBe(3);
    expect(counts.deleted).toBe(counts.created);
  });

  it("deletes bracket-matching cursors on matched and mismatched early returns", async () => {
    let doc = "let value = [1, (2 + 3)];\n";
    let state = await javascriptState(doc);
    let arrayStart = doc.indexOf("[");
    let parenEnd = doc.indexOf(")") + 1;

    let counts = countCreatedCursors(() => {
      expect(matchBrackets(state, arrayStart, 1)?.matched).toBe(true);
      expect(matchBrackets(state, parenEnd, -1)?.matched).toBe(true);
    });

    expect(counts.created).toBe(2);
    expect(counts.deleted).toBe(counts.created);
  });

  it("deletes a cursor when cursorAt positioning throws", async () => {
    let state = await javascriptState("let value = 1;\n");
    let tree = syntaxTree(state);
    let moveToDescriptor = Object.getOwnPropertyDescriptor(TreeCursor.prototype, "moveTo")!;
    let deleteDescriptor = Object.getOwnPropertyDescriptor(TreeCursor.prototype, "delete")!;
    let originalDelete = deleteDescriptor.value as (this: TreeCursor) => void;
    let deleted = 0;
    TreeCursor.prototype.moveTo = () => {
      throw new Error("positioning failed");
    };
    TreeCursor.prototype.delete = function (this: TreeCursor) {
      deleted++;
      originalDelete.call(this);
    };
    try {
      expect(() => tree.cursorAt(0)).toThrow("positioning failed");
    } finally {
      Object.defineProperty(TreeCursor.prototype, "moveTo", moveToDescriptor);
      Object.defineProperty(TreeCursor.prototype, "delete", deleteDescriptor);
    }

    expect(deleted).toBe(1);
  });

  it("deletes one-shot native parsers after success and failure", () => {
    let parser = Object.create(TreeSitterParser.prototype) as TreeSitterParser;
    let parserDeleteCalls = 0;
    let treeDeleteCalls: string[] = [];
    let nativeTree = fakeNativeTree("parsed", treeDeleteCalls);
    Object.defineProperties(parser, {
      language: { value: {} },
      nestedParsers: { value: [] },
    });
    parser.createParser = (() =>
      ({
        delete() {
          parserDeleteCalls++;
        },
      }) as NativeParser) as TreeSitterParser["createParser"];
    parser.parseWith = (() => nativeTree) as TreeSitterParser["parseWith"];
    parser.wrapTree = ((tree, doc) =>
      new Tree(tree, parser, doc.length)) as TreeSitterParser["wrapTree"];

    expect(parser.parse(Text.of(["x"])).tree).toBe(nativeTree);
    expect(parserDeleteCalls).toBe(1);
    expect(treeDeleteCalls).toEqual([]);

    parser.parseWith = (() => {
      throw new Error("parse failed");
    }) as TreeSitterParser["parseWith"];
    expect(() => parser.parse(Text.of(["x"]))).toThrow("parse failed");
    expect(parserDeleteCalls).toBe(2);
  });

  it("releases cached and highlighting queries and recreates them lazily", async () => {
    let parser = await TreeSitterParser.load(javascriptWasm, {
      highlightQuery: "(identifier) @variableName",
    });
    let highlightQuery = parser.highlightQuery!;
    let cachedQuery = compileTreeSitterQuery(parser, "(number) @number");
    let deleted: NativeQuery[] = [];

    for (let query of [highlightQuery, cachedQuery]) {
      let originalDelete = query.delete.bind(query);
      query.delete = () => {
        deleted.push(query);
        originalDelete();
      };
    }

    (parser as TreeSitterParser & { clearQueryCache(): void }).clearQueryCache();

    expect(deleted).toEqual([highlightQuery, cachedQuery]);
    expect((highlightQuery as NativeQuery & { 0: number })[0]).toBe(0);
    expect((cachedQuery as NativeQuery & { 0: number })[0]).toBe(0);
    expect(parser.highlightQuery).not.toBe(highlightQuery);
    (parser as TreeSitterParser & { clearQueryCache(): void }).clearQueryCache();
  });

  it("gives each compiled query an independent finalizable native owner", async () => {
    let parser = await TreeSitterParser.load(javascriptWasm);
    let query = compileTreeSitterQuery(parser, "(identifier) @variableName");
    let managed = (
      languageInternals as typeof languageInternals & {
        __testManagedQuery?(query: NativeQuery): boolean;
      }
    ).__testManagedQuery?.(query);

    expect(managed).toBe(true);
    expect(query).toBeInstanceOf(WebTreeSitterQuery);
    expect(query.constructor).toBe(WebTreeSitterQuery);
  });

  it("bounds each long-lived parser's compiled-query cache", async () => {
    let parser = await TreeSitterParser.load(javascriptWasm);
    let deleteDescriptor = Object.getOwnPropertyDescriptor(WebTreeSitterQuery.prototype, "delete")!;
    let originalDelete = deleteDescriptor.value as (this: NativeQuery) => void;
    let nativeDeletes = 0;
    WebTreeSitterQuery.prototype.delete = function (this: NativeQuery) {
      nativeDeletes++;
      originalDelete.call(this);
    };
    try {
      let first = compileTreeSitterQuery(parser, "(identifier) @capture0");
      for (let index = 1; index <= 64; index++) {
        compileTreeSitterQuery(parser, `(identifier) @capture${index}`);
      }
      let cacheSize = (
        languageInternals as typeof languageInternals & {
          __testCachedQueryCount?(parser: TreeSitterParser): number;
        }
      ).__testCachedQueryCount?.(parser);

      expect(cacheSize).toBe(64);
      expect(nativeDeletes).toBe(1);
      expect((first as NativeQuery & { 0: number })[0]).toBe(0);
      expect(compileTreeSitterQuery(parser, "(identifier) @capture0")).not.toBe(first);

      parser.clearQueryCache();
      expect(nativeDeletes).toBe(66);
      parser.clearQueryCache();
      expect(nativeDeletes).toBe(66);
    } finally {
      Object.defineProperty(WebTreeSitterQuery.prototype, "delete", deleteDescriptor);
      parser.clearQueryCache();
    }
  });

  it("deletes temporary edited trees used to compute changed ranges", async () => {
    let state = await javascriptState("let value = 1;\n");
    let transaction = state.update({ changes: { from: 4, to: 9, insert: "function f() {}" } });
    let oldNativeTree = syntaxTree(state).tree!;
    let originalCopy = oldNativeTree.copy.bind(oldNativeTree);
    let copyDescriptor = Object.getOwnPropertyDescriptor(oldNativeTree, "copy");
    let copies = 0;
    let deleted = 0;
    Object.defineProperty(oldNativeTree, "copy", {
      configurable: true,
      value() {
        let copy = originalCopy();
        let originalDelete = copy.delete.bind(copy);
        copies++;
        copy.delete = () => {
          deleted++;
          originalDelete();
        };
        return copy;
      },
    });
    try {
      syntaxTreeChangedRanges(transaction);
    } finally {
      if (copyDescriptor) Object.defineProperty(oldNativeTree, "copy", copyDescriptor);
      else Reflect.deleteProperty(oldNativeTree, "copy");
    }

    expect(copies).toBeGreaterThan(0);
    expect(deleted).toBe(copies);
  });

  it("disposes deeply nested wrapped trees iteratively and idempotently", () => {
    let deleted: string[] = [];
    let parser = TreeSitterParser.getSkippingParser();
    let depth = 12_000;
    let tree = new Tree(fakeNativeTree("0", deleted), parser, 1);
    for (let index = 1; index < depth; index++) {
      tree = new Tree(fakeNativeTree(String(index), deleted), parser, 1, [
        { parser, tree, ranges: [{ from: 0, to: 1 }] },
      ]);
    }
    let dispose = (
      languageInternals as typeof languageInternals & { __testDisposeWrappedTree(tree: Tree): void }
    ).__testDisposeWrappedTree;

    expect(() => dispose(tree)).not.toThrow();
    expect(() => dispose(tree)).not.toThrow();
    expect(deleted).toHaveLength(depth);
  });

  it("keeps a shared native tree until every independent wrapper is deleted", () => {
    let deleted: string[] = [];
    let parser = TreeSitterParser.getSkippingParser();
    let native = fakeNativeTree("shared", deleted);
    let first = new Tree(native, parser, 1);
    let second = new Tree(native, parser, 1);

    first.delete();
    first.delete();
    expect(deleted).toEqual([]);

    second.delete();
    second.delete();
    expect(deleted).toEqual(["shared"]);
  });
});
