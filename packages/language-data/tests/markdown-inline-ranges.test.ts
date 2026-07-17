import { Text } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { SyntaxNode, TreeCursor, type Tree } from "../../language/src/tree.js";
import {
  TreeSitterLanguage,
  queryTreeCaptures,
  queryTreeMatches,
  type DocRange,
  type TreeSitterQueryCapture,
} from "../../language/src/language.js";
import {
  collectMarkdownInlineRangeGroups,
  iterateMarkdownInlineRangeGroups,
} from "../src/markdown-inline-ranges.js";
import { languages, loadMarkdownParserService } from "../src/index.js";
import exclusionQuerySource from "../src/queries/markdown-inline-injection-exclusions.scm?raw";
import injectionQuerySource from "../src/queries/markdown-inline-injections.scm?raw";

const complexMarkdown =
  "# Heading with *emphasis*\n\n" +
  "Paragraph with **strong text**, `code`, and [a link](https://example.com).\n\n" +
  "> Quoted _value_\n" +
  "> continued with `code`\n\n" +
  "- list item **one**\n" +
  "  continued with _two_\n\n" +
  "| Name | Value |\n" +
  "| --- | --- |\n" +
  "| _alpha_ | `beta` |\n\n" +
  "```ts\nconst ignored = '*not emphasis*'\n```\n" +
  "\nFinal paragraph with ~~strikethrough~~.\n";

type CursorOperationCounts = {
  cursors: number;
  copies: number;
  firstChildren: number;
  firstChildrenForIndex: number;
  nextSiblings: number;
  deletes: number;
};

async function parseMarkdown(doc: string) {
  let service = await loadMarkdownParserService();
  let text = Text.of(doc.split("\n"));
  return { service, tree: service.blockParser.parse(text) };
}

function deleteTree(tree: Tree) {
  tree.tree?.delete();
}

function countCursorOperations() {
  let counts: CursorOperationCounts = {
    cursors: 0,
    copies: 0,
    firstChildren: 0,
    firstChildrenForIndex: 0,
    nextSiblings: 0,
    deletes: 0,
  };
  let cursorDescriptor = Object.getOwnPropertyDescriptor(SyntaxNode.prototype, "cursor")!;
  let copyDescriptor = Object.getOwnPropertyDescriptor(TreeCursor.prototype, "copy")!;
  let firstChildDescriptor = Object.getOwnPropertyDescriptor(TreeCursor.prototype, "firstChild")!;
  let firstChildForIndexDescriptor = Object.getOwnPropertyDescriptor(
    TreeCursor.prototype,
    "firstChildForIndex",
  )!;
  let nextSiblingDescriptor = Object.getOwnPropertyDescriptor(TreeCursor.prototype, "nextSibling")!;
  let deleteDescriptor = Object.getOwnPropertyDescriptor(TreeCursor.prototype, "delete")!;
  let originalCursor = cursorDescriptor.value as (this: SyntaxNode) => TreeCursor | null;
  let originalCopy = copyDescriptor.value as (this: TreeCursor) => TreeCursor;
  let originalFirstChild = firstChildDescriptor.value as (this: TreeCursor) => boolean;
  let originalFirstChildForIndex = firstChildForIndexDescriptor.value as (
    this: TreeCursor,
    index: number,
  ) => boolean;
  let originalNextSibling = nextSiblingDescriptor.value as (this: TreeCursor) => boolean;
  let originalDelete = deleteDescriptor.value as (this: TreeCursor) => void;

  SyntaxNode.prototype.cursor = function (this: SyntaxNode) {
    let cursor = originalCursor.call(this);
    if (cursor) counts.cursors++;
    return cursor;
  };
  TreeCursor.prototype.copy = function (this: TreeCursor) {
    counts.copies++;
    return originalCopy.call(this);
  };
  TreeCursor.prototype.firstChild = function (this: TreeCursor) {
    counts.firstChildren++;
    return originalFirstChild.call(this);
  };
  TreeCursor.prototype.firstChildForIndex = function (this: TreeCursor, index: number) {
    counts.firstChildrenForIndex++;
    return originalFirstChildForIndex.call(this, index);
  };
  TreeCursor.prototype.nextSibling = function (this: TreeCursor) {
    counts.nextSiblings++;
    return originalNextSibling.call(this);
  };
  TreeCursor.prototype.delete = function (this: TreeCursor) {
    counts.deletes++;
    originalDelete.call(this);
  };

  return {
    counts,
    restore() {
      Object.defineProperty(SyntaxNode.prototype, "cursor", cursorDescriptor);
      Object.defineProperty(TreeCursor.prototype, "copy", copyDescriptor);
      Object.defineProperty(TreeCursor.prototype, "firstChild", firstChildDescriptor);
      Object.defineProperty(
        TreeCursor.prototype,
        "firstChildForIndex",
        firstChildForIndexDescriptor,
      );
      Object.defineProperty(TreeCursor.prototype, "nextSibling", nextSiblingDescriptor);
      Object.defineProperty(TreeCursor.prototype, "delete", deleteDescriptor);
    },
  };
}

function traversalOperations(counts: CursorOperationCounts) {
  return (
    counts.cursors +
    counts.copies +
    counts.firstChildren +
    counts.firstChildrenForIndex +
    counts.nextSiblings
  );
}

function paragraphDocument(count: number) {
  return Array.from({ length: count }, (_, index) => `paragraph ${index} with *emphasis*`).join(
    "\n\n",
  );
}

type LinearFakeNode = {
  name: string;
  child?: LinearFakeNode;
};

class LinearFakeCursor {
  constructor(
    private current: LinearFakeNode,
    private readonly parents: LinearFakeNode[] = [],
  ) {}

  get name() {
    return this.current.name;
  }

  get from() {
    return 0;
  }

  get to() {
    return 1;
  }

  get node() {
    return { name: this.name, from: this.from, to: this.to } as SyntaxNode;
  }

  copy() {
    return new LinearFakeCursor(this.current, this.parents.slice());
  }

  firstChildForIndex(_index: number) {
    if (!this.current.child) return false;
    this.parents.push(this.current);
    this.current = this.current.child;
    return true;
  }

  firstChild() {
    return this.firstChildForIndex(this.from);
  }

  nextSibling() {
    return false;
  }

  parent() {
    let parent = this.parents.pop();
    if (!parent) return false;
    this.current = parent;
    return true;
  }

  delete() {}
}

function deeplyNestedFakeTree(depth: number): Tree {
  let root: LinearFakeNode = { name: "pipe_table_cell" };
  for (let index = 0; index < depth; index++) root = { name: "container", child: root };
  return {
    length: 1,
    topNode: {
      cursor: () => new LinearFakeCursor(root),
    } as unknown as SyntaxNode,
  } as Tree;
}

function firstGroupOperationCounts(tree: Tree) {
  let counter = countCursorOperations();
  try {
    let groups = iterateMarkdownInlineRangeGroups(tree);
    let iterator = groups[Symbol.iterator]();

    expect(counter.counts).toEqual({
      cursors: 0,
      copies: 0,
      firstChildren: 0,
      firstChildrenForIndex: 0,
      nextSiblings: 0,
      deletes: 0,
    });

    let first = iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toHaveLength(1);
    let afterFirst = { ...counter.counts };

    iterator.return?.(undefined);
    expect(counter.counts.deletes).toBe(counter.counts.cursors + counter.counts.copies);
    return afterFirst;
  } finally {
    counter.restore();
  }
}

function allGroupOperationCounts(tree: Tree) {
  let counter = countCursorOperations();
  try {
    let groupCount = Array.from(iterateMarkdownInlineRangeGroups(tree)).length;
    return { counts: { ...counter.counts }, groupCount };
  } finally {
    counter.restore();
  }
}

function legacyQueryRangeGroups(tree: Tree): DocRange[][] {
  let options = { includeNested: false };
  let exclusions = queryTreeCaptures(tree, exclusionQuerySource, options);
  return queryTreeMatches(tree, injectionQuerySource, options)
    .filter((match) => match.setProperties?.["injection.language"] == "markdown_inline")
    .flatMap((match) =>
      match.captures
        .filter((capture) => capture.name == "injection.content")
        .map((capture) =>
          rangesExcludingCaptures({ from: capture.node.from, to: capture.node.to }, exclusions),
        )
        .filter((ranges) => ranges.length),
    );
}

function rangesExcludingCaptures(range: DocRange, exclusions: readonly TreeSitterQueryCapture[]) {
  let ranges: DocRange[] = [];
  let from = range.from;
  for (let exclusion of exclusions) {
    if (exclusion.node.from < range.from || exclusion.node.to > range.to) continue;
    if (from < exclusion.node.from) ranges.push({ from, to: exclusion.node.from });
    from = Math.max(from, exclusion.node.to);
  }
  if (from < range.to) ranges.push({ from, to: range.to });
  return ranges;
}

describe("Markdown inline range groups", () => {
  it("lazily yields the same ordered groups as the existing parser service", async () => {
    let { service, tree } = await parseMarkdown(complexMarkdown);
    try {
      let expected = legacyQueryRangeGroups(tree);
      let actual = Array.from(iterateMarkdownInlineRangeGroups(tree));

      expect(actual).toEqual(expected);
      expect(service.inlineRanges(tree)).toEqual(expected);
      expect(actual.length).toBeGreaterThan(8);
      expect(actual.some((ranges) => ranges.length > 1)).toBe(true);
    } finally {
      deleteTree(tree);
    }
  });

  it("keeps the compatibility collector as a concrete DocRange[][] array", async () => {
    let { service, tree } = await parseMarkdown(complexMarkdown);
    try {
      let groups = collectMarkdownInlineRangeGroups(tree);

      expect(Array.isArray(groups)).toBe(true);
      expect(groups.every((ranges) => Array.isArray(ranges))).toBe(true);
      expect(groups).toEqual(service.inlineRanges(tree));
    } finally {
      deleteTree(tree);
    }
  });

  it("wires generic Markdown nesting to the lazy producer while keeping the service eager", async () => {
    let { service, tree } = await parseMarkdown(complexMarkdown);
    let generic = await languages.find((language) => language.name == "Markdown")!.load();
    expect(generic.language).toBeInstanceOf(TreeSitterLanguage);
    let source = (generic.language as TreeSitterLanguage).parser.nestedParsers[0]!;

    try {
      let lazyGroups = source.ranges(tree);
      expect(Array.isArray(lazyGroups)).toBe(false);
      let iterator = (lazyGroups as Iterable<readonly DocRange[]>)[Symbol.iterator]();
      let first = iterator.next();

      expect(first.done).toBe(false);
      expect(first.value).toEqual(service.inlineRanges(tree)[0]);
      iterator.return?.();
      expect(Array.isArray(service.inlineRanges(tree))).toBe(true);
    } finally {
      deleteTree(tree);
    }
  });

  it("does no work at construction and bounds the work needed for the first group", async () => {
    let small = await parseMarkdown(paragraphDocument(10));
    let large = await parseMarkdown(paragraphDocument(10_000));
    try {
      let smallCounts = firstGroupOperationCounts(small.tree);
      let largeCounts = firstGroupOperationCounts(large.tree);

      expect(traversalOperations(smallCounts)).toBeGreaterThan(0);
      expect(traversalOperations(largeCounts)).toBeGreaterThan(0);
      expect(traversalOperations(largeCounts)).toBeLessThanOrEqual(
        traversalOperations(smallCounts) + 4,
      );
      expect(traversalOperations(largeCounts)).toBeLessThanOrEqual(32);
    } finally {
      deleteTree(small.tree);
      deleteTree(large.tree);
    }
  });

  it("uses linearly bounded cursor work when all 10,000 groups are consumed", async () => {
    let smallCount = 10;
    let largeCount = 10_000;
    let small = await parseMarkdown(paragraphDocument(smallCount));
    let large = await parseMarkdown(paragraphDocument(largeCount));
    try {
      let smallResult = allGroupOperationCounts(small.tree);
      let largeResult = allGroupOperationCounts(large.tree);
      let scale = largeCount / smallCount;

      expect(smallResult.groupCount).toBe(smallCount);
      expect(largeResult.groupCount).toBe(largeCount);
      expect(smallResult.counts.deletes).toBe(
        smallResult.counts.cursors + smallResult.counts.copies,
      );
      expect(largeResult.counts.deletes).toBe(
        largeResult.counts.cursors + largeResult.counts.copies,
      );
      expect(traversalOperations(largeResult.counts)).toBeLessThanOrEqual(
        traversalOperations(smallResult.counts) * scale + 64,
      );
    } finally {
      deleteTree(small.tree);
      deleteTree(large.tree);
    }
  });

  it("deletes every live cursor when iteration stops after the first group", async () => {
    let { tree } = await parseMarkdown(complexMarkdown);
    let counter = countCursorOperations();
    try {
      let iterator = iterateMarkdownInlineRangeGroups(tree)[Symbol.iterator]();
      expect(iterator.next().done).toBe(false);
      expect(counter.counts.cursors + counter.counts.copies).toBeGreaterThan(0);

      iterator.return?.(undefined);

      expect(counter.counts.deletes).toBe(counter.counts.cursors + counter.counts.copies);
    } finally {
      counter.restore();
      deleteTree(tree);
    }
  });

  it("deletes every live cursor when the consumer throws into the generator", async () => {
    let { tree } = await parseMarkdown(complexMarkdown);
    let counter = countCursorOperations();
    let iterator = iterateMarkdownInlineRangeGroups(tree)[Symbol.iterator]();
    try {
      expect(iterator.next().done).toBe(false);
      expect(counter.counts.cursors + counter.counts.copies).toBeGreaterThan(0);

      let failure = new Error("consumer stopped");
      expect(() => iterator.throw(failure)).toThrow(failure);

      expect(counter.counts.deletes).toBe(counter.counts.cursors + counter.counts.copies);
    } finally {
      iterator.return?.(undefined);
      counter.restore();
      deleteTree(tree);
    }
  });

  it("deletes every live cursor when traversal throws internally", async () => {
    let { tree } = await parseMarkdown(complexMarkdown);
    let counter = countCursorOperations();
    let iterator = iterateMarkdownInlineRangeGroups(tree)[Symbol.iterator]();
    let countedNextSiblingDescriptor = Object.getOwnPropertyDescriptor(
      TreeCursor.prototype,
      "nextSibling",
    )!;
    try {
      expect(iterator.next().done).toBe(false);
      expect(counter.counts.cursors + counter.counts.copies).toBeGreaterThan(0);

      let failure = new Error("cursor failed");
      TreeCursor.prototype.nextSibling = function () {
        throw failure;
      };
      expect(() => iterator.next()).toThrow(failure);

      expect(counter.counts.deletes).toBe(counter.counts.cursors + counter.counts.copies);
    } finally {
      Object.defineProperty(TreeCursor.prototype, "nextSibling", countedNextSiblingDescriptor);
      iterator.return?.(undefined);
      counter.restore();
      deleteTree(tree);
    }
  });

  it("does not consume JavaScript call stack in proportion to Markdown tree depth", () => {
    let iterator = iterateMarkdownInlineRangeGroups(deeplyNestedFakeTree(5_000));
    let first: IteratorResult<DocRange[]> | undefined;

    expect(() => {
      first = iterator.next();
    }).not.toThrow();
    expect(first).toEqual({ done: false, value: [{ from: 0, to: 1 }] });
    iterator.return(undefined);
  });

  it("preserves fixed bounded-range behavior at block and table-cell edges", async () => {
    let { service, tree } = await parseMarkdown(complexMarkdown);
    let headingFrom = complexMarkdown.indexOf("Heading");
    let headingTo = complexMarkdown.indexOf("\n\n");
    let paragraphFrom = complexMarkdown.indexOf("Paragraph");
    let paragraphTo = complexMarkdown.indexOf("\n\n", paragraphFrom);
    let quoteFrom = complexMarkdown.indexOf("Quoted");
    let quoteContinuationFrom = complexMarkdown.indexOf("continued with `code`");
    let quoteTo = quoteContinuationFrom + "continued with `code`".length;
    let alphaFrom = complexMarkdown.indexOf("_alpha_");
    let alphaTo = alphaFrom + "_alpha_ ".length;
    let betaFrom = complexMarkdown.indexOf("`beta`");
    let betaTo = betaFrom + "`beta` ".length;
    let cases: { within: DocRange; expected: DocRange[][] }[] = [
      {
        within: { from: headingFrom, to: headingFrom + "Heading".length },
        expected: [[{ from: headingFrom, to: headingTo }]],
      },
      {
        within: { from: headingTo, to: paragraphFrom },
        expected: [],
      },
      {
        within: { from: headingTo - 1, to: paragraphFrom + 1 },
        expected: [
          [{ from: headingFrom, to: headingTo }],
          [{ from: paragraphFrom, to: paragraphTo }],
        ],
      },
      {
        within: { from: quoteContinuationFrom, to: quoteTo },
        expected: [
          [
            { from: quoteFrom, to: quoteContinuationFrom - 2 },
            { from: quoteContinuationFrom, to: quoteTo },
          ],
        ],
      },
      {
        within: { from: alphaFrom - 1, to: alphaFrom },
        expected: [],
      },
      {
        within: { from: alphaFrom, to: betaTo },
        expected: [[{ from: alphaFrom, to: alphaTo }], [{ from: betaFrom, to: betaTo }]],
      },
      {
        within: { from: betaTo - 1, to: betaTo },
        expected: [[{ from: betaFrom, to: betaTo }]],
      },
      {
        within: { from: betaTo, to: betaTo + 1 },
        expected: [],
      },
      {
        within: { from: complexMarkdown.length, to: complexMarkdown.length },
        expected: [],
      },
    ];

    try {
      let legacyGroups = legacyQueryRangeGroups(tree);
      for (let { within, expected } of cases) {
        let legacyBounded = legacyGroups.filter((ranges) =>
          ranges.some((range) => range.from < within.to && within.from < range.to),
        );

        expect(legacyBounded).toEqual(expected);
        expect(Array.from(iterateMarkdownInlineRangeGroups(tree, within))).toEqual(expected);
        expect(collectMarkdownInlineRangeGroups(tree, within)).toEqual(expected);
        expect(service.inlineRanges(tree, within)).toEqual(expected);
      }
    } finally {
      deleteTree(tree);
    }
  });
});
