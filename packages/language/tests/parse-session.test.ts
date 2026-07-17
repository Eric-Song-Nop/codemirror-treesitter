import { Compartment, EditorState, type Text } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  defineLanguageFacet,
  ensureSyntaxTree,
  Language,
  ParseContext,
  Tree,
  TreeSitterParser,
  type DocRange,
} from "../src/index.js";
import type { NestedParserSource } from "../src/language.js";
import type { Parser as NativeParser, Tree as NativeTree } from "web-tree-sitter";

const pause = Symbol("pause fake native parse");

type FakeParseTask = {
  doc: Text;
  oldTree: NativeTree | null;
  ranges: readonly DocRange[] | undefined;
};

type FakeParseInput = FakeParseTask & {
  resuming: boolean;
};

type FakeParseBehavior = (input: FakeParseInput) => NativeTree | typeof pause;

type FakeNativeTree = NativeTree & {
  readonly label: string;
  deleteCalls: number;
};

class FakeNativeParser {
  private activeTask: FakeParseTask | null = null;
  resetCalls = 0;
  deleteCalls = 0;

  constructor(private readonly parseBehavior: FakeParseBehavior) {}

  parseTask(
    doc: Text,
    oldTree: NativeTree | null,
    ranges: readonly DocRange[] | undefined,
  ): NativeTree | null {
    let task = { doc, oldTree, ranges };
    if (this.activeTask) {
      if (!sameTask(this.activeTask, task)) {
        throw new Error(
          `attempted ${rangeGroupKey(ranges)} while ${rangeGroupKey(this.activeTask.ranges)} was suspended`,
        );
      }
      let result = this.parseBehavior({ ...task, resuming: true });
      if (result === pause) return null;
      this.activeTask = null;
      return result;
    }

    let result = this.parseBehavior({ ...task, resuming: false });
    if (result === pause) {
      this.activeTask = task;
      return null;
    }
    return result;
  }

  reset() {
    this.resetCalls++;
    this.activeTask = null;
  }

  delete() {
    this.deleteCalls++;
    this.activeTask = null;
  }
}

function fakeParser(
  parseBehavior: FakeParseBehavior,
  nestedParsers: readonly NestedParserSource[] = [],
  created?: FakeNativeParser[],
): TreeSitterParser {
  let parser = Object.create(TreeSitterParser.prototype) as TreeSitterParser;
  Object.defineProperties(parser, {
    implicitFinalNewline: { value: false },
    language: { value: {} },
    nestedParsers: { value: nestedParsers },
  });
  parser.createParser = (() => {
    let nativeParser = new FakeNativeParser(parseBehavior);
    created?.push(nativeParser);
    return nativeParser as unknown as NativeParser;
  }) as (typeof parser)["createParser"];
  parser.parseWith = ((
    nativeParser: NativeParser,
    doc: Text,
    oldTree: NativeTree | null,
    _shouldStop?: () => boolean,
    ranges?: readonly DocRange[],
  ) =>
    (nativeParser as unknown as FakeNativeParser).parseTask(
      doc,
      oldTree,
      ranges,
    )) as TreeSitterParser["parseWith"];
  return parser;
}

function fakeTree(label: string): FakeNativeTree {
  let tree = {
    label,
    deleteCalls: 0,
    delete() {
      tree.deleteCalls++;
    },
  };
  return tree as unknown as FakeNativeTree;
}

function sameTask(left: FakeParseTask, right: FakeParseTask) {
  return (
    left.doc === right.doc &&
    left.oldTree === right.oldTree &&
    rangeGroupKey(left.ranges) == rangeGroupKey(right.ranges)
  );
}

function rangeGroupKey(ranges: readonly DocRange[] | undefined) {
  return ranges ? ranges.map((range) => `${range.from}:${range.to}`).join(",") : "root";
}

function throwingRangeGroups(message: string): Iterable<readonly DocRange[]> {
  return {
    [Symbol.iterator]() {
      let yielded = false;
      return {
        next(): IteratorResult<readonly DocRange[]> {
          if (yielded) return { done: true, value: undefined };
          yielded = true;
          return { done: false, value: [{ from: 0, to: 1 }] };
        },
        return(): IteratorResult<readonly DocRange[]> {
          throw new Error(message);
        },
      };
    },
  };
}

function keepNestedOnEqualLengthEdit(parser: TreeSitterParser) {
  let editCount = 0;
  parser.editWrappedTree = ((tree: Tree, _changes: unknown, oldDoc: Text, newDoc: Text) => {
    if (oldDoc.length != newDoc.length) throw new Error("fake edit must preserve document length");
    return new Tree(fakeTree(`edited-root-${++editCount}`), parser, newDoc.length, tree.nested);
  }) as TreeSitterParser["editWrappedTree"];
}

function directReuseFixture(doc: string, groups: readonly (readonly DocRange[])[]) {
  let nestedCalls: string[] = [];
  let nested = fakeParser(({ ranges }) => {
    let key = rangeGroupKey(ranges);
    nestedCalls.push(key);
    return fakeTree(`nested-${nestedCalls.length}-${key}`);
  });
  let sourceCalls = 0;
  let root = fakeParser(
    () => fakeTree("root"),
    [
      {
        parser: nested,
        ranges() {
          sourceCalls++;
          return groups;
        },
      },
    ],
  );
  keepNestedOnEqualLengthEdit(root);
  let state = EditorState.create({ doc });
  let context = ParseContext.create(root, state);
  expect(context.work(() => false)).toBe(true);
  return { context, state, nestedCalls, sourceCalls: () => sourceCalls };
}

function changedContext(context: ParseContext, state: EditorState, from: number, insert: string) {
  let transaction = state.update({ changes: { from, to: from + insert.length, insert } });
  return {
    context: context.changes(transaction.changes, state, transaction.state),
    state: transaction.state,
  };
}

describe("resumable nested parse sessions", () => {
  it("explicitly releases a parse context's root native parser exactly once", () => {
    let created: FakeNativeParser[] = [];
    let root = fakeParser(() => fakeTree("root"), [], created);
    let context = ParseContext.create(root, EditorState.create({ doc: "x" }));

    (context as ParseContext & { destroy(): void }).destroy();
    (context as ParseContext & { destroy(): void }).destroy();

    expect(created).toHaveLength(1);
    expect(created[0]!.deleteCalls).toBe(1);
  });

  it("keeps an old editor state's parse context usable after reconfiguration", () => {
    let calls = 0;
    let created: FakeNativeParser[] = [];
    let root = fakeParser(() => (++calls == 1 ? pause : fakeTree("old-state-root")), [], created);
    let replacement = fakeParser(() => fakeTree("replacement-root"));
    let currentLanguage = new Language(defineLanguageFacet(), root);
    let replacementLanguage = new Language(defineLanguageFacet(), replacement);
    let compartment = new Compartment();
    let state = EditorState.create({
      doc: "xxxx",
      extensions: [compartment.of(currentLanguage.extension)],
    });

    void state.update({ effects: compartment.reconfigure(replacementLanguage.extension) }).state;

    expect(() => ensureSyntaxTree(state, state.doc.length)).not.toThrow();
    expect(ensureSyntaxTree(state, state.doc.length)).not.toBeNull();
    expect(created[0]!.deleteCalls).toBe(0);
  });

  it("checks the budget between tiny groups and resumes without replay before publishing", () => {
    let nestedCalls: string[] = [];
    let stop = false;
    let nested = fakeParser(({ ranges }) => {
      nestedCalls.push(rangeGroupKey(ranges));
      if (nestedCalls.length == 1) stop = true;
      return fakeTree(`nested-${nestedCalls.length}`);
    });
    let sourceCalls = 0;
    let root = fakeParser(
      () => fakeTree("root"),
      [
        {
          parser: nested,
          ranges() {
            sourceCalls++;
            return [[{ from: 0, to: 1 }], [{ from: 2, to: 3 }], [{ from: 4, to: 5 }]];
          },
        },
      ],
    );
    let context = ParseContext.create(root, EditorState.create({ doc: "abcdef" }));

    expect(context.work(() => stop)).toBe(false);
    expect(sourceCalls).toBe(1);
    expect(nestedCalls).toEqual(["0:1"]);
    expect(context.tree).toBe(Tree.empty);

    stop = false;
    expect(context.work(() => false)).toBe(true);
    expect(sourceCalls).toBe(1);
    expect(nestedCalls).toEqual(["0:1", "2:3", "4:5"]);
    expect(context.tree.nested.map((nestedTree) => rangeGroupKey(nestedTree.ranges))).toEqual([
      "0:1",
      "2:3",
      "4:5",
    ]);
  });

  it("resumes the suspended group before using its native parser for a sibling", () => {
    let calls: string[] = [];
    let nested = fakeParser(({ ranges, resuming }) => {
      let key = rangeGroupKey(ranges);
      if (key == "2:3" && !resuming) {
        calls.push(`${key}:pause`);
        return pause;
      }
      calls.push(`${key}:${resuming ? "resume" : "complete"}`);
      return fakeTree(`nested-${key}`);
    });
    let sourceCalls = 0;
    let root = fakeParser(
      () => fakeTree("root"),
      [
        {
          parser: nested,
          ranges() {
            sourceCalls++;
            return [[{ from: 0, to: 1 }], [{ from: 2, to: 3 }], [{ from: 4, to: 5 }]];
          },
        },
      ],
    );
    let context = ParseContext.create(root, EditorState.create({ doc: "abcdef" }));

    expect(context.work(() => false)).toBe(false);
    expect(calls).toEqual(["0:1:complete", "2:3:pause"]);
    expect(context.tree).toBe(Tree.empty);

    expect(() => context.work(() => false)).not.toThrow();
    expect(sourceCalls).toBe(1);
    expect(calls).toEqual(["0:1:complete", "2:3:pause", "2:3:resume", "4:5:complete"]);
    expect(context.tree.nested.map((nestedTree) => rangeGroupKey(nestedTree.ranges))).toEqual([
      "0:1",
      "2:3",
      "4:5",
    ]);
  });

  it("deletes session-owned nested parsers after a successful commit", () => {
    let created: FakeNativeParser[] = [];
    let nestedTree = fakeTree("nested");
    let nested = fakeParser(() => nestedTree, [], created);
    let root = fakeParser(
      () => fakeTree("root"),
      [{ parser: nested, ranges: () => [[{ from: 0, to: 1 }]] }],
    );
    let context = ParseContext.create(root, EditorState.create({ doc: "x" }));

    expect(context.work(() => false)).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.resetCalls).toBe(0);
    expect(created[0]!.deleteCalls).toBe(1);
    expect(nestedTree.deleteCalls).toBe(0);
  });

  it("resets and deletes a suspended nested parser when the session is reset", () => {
    let created: FakeNativeParser[] = [];
    let completedTree = fakeTree("completed-before-pause");
    let nested = fakeParser(
      ({ ranges }) => (rangeGroupKey(ranges) == "0:1" ? completedTree : pause),
      [],
      created,
    );
    let root = fakeParser(
      () => fakeTree("root"),
      [
        {
          parser: nested,
          ranges: () => [[{ from: 0, to: 1 }], [{ from: 2, to: 3 }]],
        },
      ],
    );
    let context = ParseContext.create(root, EditorState.create({ doc: "xxxx" }));

    expect(context.work(() => false)).toBe(false);
    context.reset();

    expect(created).toHaveLength(1);
    expect(created[0]!.resetCalls).toBe(1);
    expect(created[0]!.deleteCalls).toBe(1);
    expect(completedTree.deleteCalls).toBe(1);
  });

  it("releases an incomplete nested session when changes supersede its context", () => {
    let rootParsers: FakeNativeParser[] = [];
    let nestedParsers: FakeNativeParser[] = [];
    let rootTrees: FakeNativeTree[] = [];
    let completedTree = fakeTree("completed-before-change");
    let closed = 0;
    let shouldPause = true;
    function* rangeGroups() {
      try {
        yield [{ from: 0, to: 1 }];
        yield [{ from: 2, to: 3 }];
      } finally {
        closed++;
      }
    }
    let nested = fakeParser(
      ({ ranges }) => {
        if (!shouldPause) return fakeTree(`nested-after-change-${rangeGroupKey(ranges)}`);
        return rangeGroupKey(ranges) == "0:1" ? completedTree : pause;
      },
      [],
      nestedParsers,
    );
    let root = fakeParser(
      () => {
        let tree = fakeTree(`root-${rootTrees.length + 1}`);
        rootTrees.push(tree);
        return tree;
      },
      [{ parser: nested, ranges: rangeGroups }],
      rootParsers,
    );
    let state = EditorState.create({ doc: "xxxx" });
    let context = ParseContext.create(root, state);

    expect(context.work(() => false)).toBe(false);
    expect(closed).toBe(0);
    expect(rootParsers).toHaveLength(1);
    expect(nestedParsers).toHaveLength(1);

    let transaction = state.update({ changes: { from: 0, to: 1, insert: "y" } });
    context.changes(transaction.changes, state, transaction.state);

    expect(closed).toBe(1);
    expect(rootParsers[0]!.resetCalls).toBe(1);
    expect(rootParsers[0]!.deleteCalls).toBe(0);
    expect(nestedParsers[0]!.resetCalls).toBe(1);
    expect(nestedParsers[0]!.deleteCalls).toBe(1);
    expect(rootTrees[0]!.deleteCalls).toBe(1);
    expect(completedTree.deleteCalls).toBe(1);

    context.reset();
    expect(closed).toBe(1);
    expect(rootParsers[0]!.resetCalls).toBe(2);
    expect(rootParsers[0]!.deleteCalls).toBe(0);
    expect(nestedParsers[0]!.resetCalls).toBe(1);
    expect(nestedParsers[0]!.deleteCalls).toBe(1);
    expect(rootTrees[0]!.deleteCalls).toBe(1);
    expect(completedTree.deleteCalls).toBe(1);

    shouldPause = false;
    expect(context.work(() => false)).toBe(true);
    expect(rootTrees).toHaveLength(2);
  });

  it("does not delete a borrowed root when changes supersede a reset rebuild", () => {
    let rootParsers: FakeNativeParser[] = [];
    let nestedParsers: FakeNativeParser[] = [];
    let rootTrees: FakeNativeTree[] = [];
    let resetBuildTree: FakeNativeTree | null = null;
    let closed = 0;
    let rebuilding = false;
    function* rangeGroups() {
      try {
        yield [{ from: 0, to: 1 }];
        yield [{ from: 2, to: 3 }];
      } finally {
        closed++;
      }
    }
    let nested = fakeParser(
      ({ ranges }) => {
        let key = rangeGroupKey(ranges);
        if (rebuilding && key == "2:3") return pause;
        let tree = fakeTree(`nested-${key}`);
        if (rebuilding && key == "0:1") resetBuildTree = tree;
        return tree;
      },
      [],
      nestedParsers,
    );
    let root = fakeParser(
      () => {
        let tree = fakeTree(`root-${rootTrees.length + 1}`);
        rootTrees.push(tree);
        return tree;
      },
      [{ parser: nested, ranges: rangeGroups }],
      rootParsers,
    );
    let state = EditorState.create({ doc: "xxxx" });
    let context = ParseContext.create(root, state);

    expect(context.work(() => false)).toBe(true);
    let publishedRoot = rootTrees[0]!;
    expect(closed).toBe(1);

    context.reset();
    rebuilding = true;
    expect(context.work(() => false)).toBe(false);
    expect(closed).toBe(1);
    expect(resetBuildTree).not.toBeNull();

    let transaction = state.update({ changes: { from: 0, to: 1, insert: "y" } });
    context.changes(transaction.changes, state, transaction.state);

    expect(closed).toBe(2);
    expect(publishedRoot.deleteCalls).toBe(0);
    expect(resetBuildTree!.deleteCalls).toBe(1);
    expect(nestedParsers[1]!.resetCalls).toBe(1);
    expect(nestedParsers[1]!.deleteCalls).toBe(1);

    rebuilding = false;
    expect(context.work(() => false)).toBe(true);
    expect(rootTrees).toHaveLength(2);
    expect(publishedRoot.deleteCalls).toBe(0);
  });

  it("releases an incomplete nested session when its language is reconfigured", () => {
    let rootParsers: FakeNativeParser[] = [];
    let nestedParsers: FakeNativeParser[] = [];
    let pendingRootTree = fakeTree("pending-before-reconfigure");
    let completedTree = fakeTree("completed-before-reconfigure");
    let closed = 0;
    function* rangeGroups() {
      try {
        yield [{ from: 0, to: 1 }];
        yield [{ from: 2, to: 3 }];
      } finally {
        closed++;
      }
    }
    let nested = fakeParser(
      ({ ranges }) => (rangeGroupKey(ranges) == "0:1" ? completedTree : pause),
      [],
      nestedParsers,
    );
    let root = fakeParser(
      () => pendingRootTree,
      [{ parser: nested, ranges: rangeGroups }],
      rootParsers,
    );
    let replacement = fakeParser(() => fakeTree("replacement-root"));
    let currentLanguage = new Language(defineLanguageFacet(), root);
    let replacementLanguage = new Language(defineLanguageFacet(), replacement);
    let compartment = new Compartment();
    let state = EditorState.create({
      doc: "xxxx",
      extensions: [compartment.of(currentLanguage.extension)],
    });

    expect(closed).toBe(0);
    expect(
      () => state.update({ effects: compartment.reconfigure(replacementLanguage.extension) }).state,
    ).not.toThrow();

    expect(closed).toBe(1);
    expect(rootParsers[0]!.resetCalls).toBe(1);
    expect(rootParsers[0]!.deleteCalls).toBe(0);
    expect(nestedParsers[0]!.resetCalls).toBe(1);
    expect(nestedParsers[0]!.deleteCalls).toBe(1);
    expect(pendingRootTree.deleteCalls).toBe(1);
    expect(completedTree.deleteCalls).toBe(1);
  });

  it("releases nested parsers when a parse task throws", () => {
    let created: FakeNativeParser[] = [];
    let completedTree = fakeTree("completed-before-error");
    let nested = fakeParser(
      ({ ranges }) => {
        if (rangeGroupKey(ranges) == "0:1") return completedTree;
        throw new Error("nested parse failed");
      },
      [],
      created,
    );
    let root = fakeParser(
      () => fakeTree("root"),
      [
        {
          parser: nested,
          ranges: () => [[{ from: 0, to: 1 }], [{ from: 2, to: 3 }]],
        },
      ],
    );
    let context = ParseContext.create(root, EditorState.create({ doc: "xxxx" }));

    expect(() => context.work(() => false)).toThrow("nested parse failed");
    expect(created).toHaveLength(1);
    expect(created[0]!.resetCalls).toBe(1);
    expect(created[0]!.deleteCalls).toBe(1);
    expect(completedTree.deleteCalls).toBe(1);
  });

  it("reparses the root after a transient nested parse failure", () => {
    let rootCalls = 0;
    let nestedCalls = 0;
    let roots: FakeNativeTree[] = [];
    let nested = fakeParser(() => {
      if (++nestedCalls == 1) throw new Error("transient nested failure");
      return fakeTree("nested-after-retry");
    });
    let root = fakeParser(() => {
      rootCalls++;
      let tree = fakeTree(`root-${rootCalls}`);
      roots.push(tree);
      return tree;
    }, [{ parser: nested, ranges: () => [[{ from: 0, to: 1 }]] }]);
    let context = ParseContext.create(root, EditorState.create({ doc: "x" }));

    expect(() => context.work(() => false)).toThrow("transient nested failure");
    expect(rootCalls).toBe(1);
    expect(roots[0]!.deleteCalls).toBe(1);

    expect(context.work(() => false)).toBe(true);
    expect(rootCalls).toBe(2);
  });

  it("resumes a grouped range iterable without rebuilding or replaying it", () => {
    let sourceCalls = 0;
    let pulled = 0;
    let closed = 0;
    let nestedCalls: string[] = [];
    let stop = false;
    let nested = fakeParser(({ ranges }) => {
      nestedCalls.push(rangeGroupKey(ranges));
      if (nestedCalls.length == 1) stop = true;
      return fakeTree(`nested-${nestedCalls.length}`);
    });
    function* rangeGroups() {
      try {
        for (let index = 0; index < 3; index++) {
          pulled++;
          yield [{ from: index * 2, to: index * 2 + 1 }];
        }
      } finally {
        closed++;
      }
    }
    let root = fakeParser(
      () => fakeTree("root"),
      [
        {
          parser: nested,
          ranges: () => {
            sourceCalls++;
            return rangeGroups();
          },
        },
      ],
    );
    let context = ParseContext.create(root, EditorState.create({ doc: "abcdef" }));

    expect(context.work(() => stop)).toBe(false);
    expect(sourceCalls).toBe(1);
    expect(pulled).toBe(1);
    expect(closed).toBe(0);
    expect(nestedCalls).toEqual(["0:1"]);
    expect(context.tree).toBe(Tree.empty);

    stop = false;
    expect(context.work(() => false)).toBe(true);
    expect(sourceCalls).toBe(1);
    expect(pulled).toBe(3);
    expect(closed).toBe(1);
    expect(nestedCalls).toEqual(["0:1", "2:3", "4:5"]);
  });

  it("closes a suspended grouped range iterator exactly once when reset cancels it", () => {
    let sourceCalls = 0;
    let pulled = 0;
    let closed = 0;
    let stop = false;
    let nested = fakeParser(() => {
      stop = true;
      return fakeTree("nested");
    });
    function* rangeGroups() {
      try {
        for (let index = 0; index < 3; index++) {
          pulled++;
          yield [{ from: index * 2, to: index * 2 + 1 }];
        }
      } finally {
        closed++;
      }
    }
    let root = fakeParser(
      () => fakeTree("root"),
      [
        {
          parser: nested,
          ranges: () => {
            sourceCalls++;
            return rangeGroups();
          },
        },
      ],
    );
    let context = ParseContext.create(root, EditorState.create({ doc: "abcdef" }));

    expect(context.work(() => stop)).toBe(false);
    expect(sourceCalls).toBe(1);
    expect(pulled).toBe(1);
    expect(closed).toBe(0);

    context.reset();
    context.reset();
    expect(closed).toBe(1);
  });

  it("releases a suspended session even when its range iterator throws while closing", () => {
    let nestedParsers: FakeNativeParser[] = [];
    let pendingRoot = fakeTree("pending-root");
    let nested = fakeParser(() => pause, [], nestedParsers);
    let root = fakeParser(
      () => pendingRoot,
      [{ parser: nested, ranges: () => throwingRangeGroups("range iterator close failed") }],
    );
    let context = ParseContext.create(root, EditorState.create({ doc: "xx" }));

    expect(context.work(() => false)).toBe(false);
    expect(() => context.reset()).toThrow("range iterator close failed");

    expect(pendingRoot.deleteCalls).toBe(1);
    expect(nestedParsers[0]!.resetCalls).toBe(1);
    expect(nestedParsers[0]!.deleteCalls).toBe(1);
  });

  it("preserves a parse failure when iterator cleanup also fails", () => {
    let nestedParsers: FakeNativeParser[] = [];
    let pendingRoot = fakeTree("pending-root-before-double-failure");
    let nested = fakeParser(
      () => {
        throw new Error("primary nested parse failure");
      },
      [],
      nestedParsers,
    );
    let root = fakeParser(
      () => pendingRoot,
      [
        {
          parser: nested,
          ranges: () => throwingRangeGroups("secondary iterator close failure"),
        },
      ],
    );
    let context = ParseContext.create(root, EditorState.create({ doc: "xx" }));

    expect(() => context.work(() => false)).toThrow("primary nested parse failure");
    expect(pendingRoot.deleteCalls).toBe(1);
    expect(nestedParsers[0]!.deleteCalls).toBe(1);
  });

  it("finishes destroying a context when iterator cleanup fails", () => {
    let rootParsers: FakeNativeParser[] = [];
    let nestedParsers: FakeNativeParser[] = [];
    let pendingRoot = fakeTree("pending-root-before-destroy");
    let nested = fakeParser(() => pause, [], nestedParsers);
    let root = fakeParser(
      () => pendingRoot,
      [{ parser: nested, ranges: () => throwingRangeGroups("destroy iterator close failure") }],
      rootParsers,
    );
    let context = ParseContext.create(root, EditorState.create({ doc: "xx" }));

    expect(context.work(() => false)).toBe(false);
    expect(() => context.destroy()).toThrow("destroy iterator close failure");
    expect(pendingRoot.deleteCalls).toBe(1);
    expect(nestedParsers[0]!.deleteCalls).toBe(1);
    expect(rootParsers[0]!.deleteCalls).toBe(1);

    expect(() => context.destroy()).not.toThrow();
    expect(rootParsers[0]!.deleteCalls).toBe(1);
  });

  it("keeps flat ranges in one group while arrays and iterables produce multiple groups", () => {
    function parsedGroups(ranges: NestedParserSource["ranges"]) {
      let calls: string[] = [];
      let nested = fakeParser(({ ranges }) => {
        calls.push(rangeGroupKey(ranges));
        return fakeTree(`nested-${calls.length}`);
      });
      let root = fakeParser(
        () => fakeTree("root"),
        [
          {
            parser: nested,
            ranges,
          },
        ],
      );
      let context = ParseContext.create(root, EditorState.create({ doc: "abcdef" }));
      expect(context.work(() => false)).toBe(true);
      return calls;
    }

    expect(
      parsedGroups(() => [
        { from: 0, to: 1 },
        { from: 3, to: 4 },
      ]),
    ).toEqual(["0:1,3:4"]);
    expect(parsedGroups(() => [[{ from: 0, to: 1 }], [{ from: 3, to: 4 }]])).toEqual([
      "0:1",
      "3:4",
    ]);
    expect(
      parsedGroups(function* () {
        yield [{ from: 0, to: 1 }];
        yield [{ from: 3, to: 4 }];
      }),
    ).toEqual(["0:1", "3:4"]);
  });
});

describe("incremental nested direct reuse", () => {
  it("releases cloned reuse wrappers when an incremental build is cancelled", () => {
    let fixture = directReuseFixture("abcdef", [[{ from: 0, to: 1 }]]);
    let oldNested = fixture.context.tree.nested[0]!.tree;
    let nativeNested = oldNested.tree as FakeNativeTree;
    let stop = false;
    let observedNested = new Proxy(oldNested, {
      get(target, property, receiver) {
        if (property == "tree") stop = true;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    fixture.context.tree = new Tree(fakeTree("old-root"), fixture.context.tree.config, 6, [
      { ...fixture.context.tree.nested[0]!, tree: observedNested },
    ]);
    let next = changedContext(fixture.context, fixture.state, 4, "Z");

    expect(next.context.work(() => stop)).toBe(false);
    next.context.reset();
    oldNested.delete();

    expect(nativeNested.deleteCalls).toBe(1);
  });

  it("checks the budget before indexing old nested groups and resumes without replay", () => {
    let count = 10_000;
    let reusedRanges = [{ from: (count - 1) * 2, to: (count - 1) * 2 + 1 }];
    let nested = fakeParser(() => fakeTree("unexpected nested parse"));
    let sourceCalls = 0;
    let root = fakeParser(
      () => fakeTree("root"),
      [
        {
          parser: nested,
          ranges() {
            sourceCalls++;
            return [reusedRanges];
          },
        },
      ],
    );
    keepNestedOnEqualLengthEdit(root);
    let reads = 0;
    let trees = Array.from({ length: count }, (_, index) => ({
      parser: nested,
      ranges: [{ from: index * 2, to: index * 2 + 1 }],
      tree: new Tree(fakeTree(`old-${index}`), nested, count * 2),
    }));
    let reused = trees[count - 1]!;
    let oldNested = new Proxy(trees, {
      get(target, property, receiver) {
        if (typeof property == "string" && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    let state = EditorState.create({ doc: "x".repeat(count * 2) });
    let context = ParseContext.create(root, state);
    context.tree = new Tree(fakeTree("old-root"), root, state.doc.length, oldNested);
    let transaction = state.update({ changes: { from: 0, to: 1, insert: "y" } });
    let next = context.changes(transaction.changes, state, transaction.state);

    let stopAfter = 0;
    expect(next.work(() => reads >= stopAfter)).toBe(false);
    expect(reads).toBe(0);
    expect(sourceCalls).toBe(0);

    stopAfter = 64;
    expect(next.work(() => reads >= stopAfter)).toBe(false);
    expect(reads).toBe(64);
    expect(sourceCalls).toBe(0);

    stopAfter = 128;
    expect(next.work(() => reads >= stopAfter)).toBe(false);
    expect(reads).toBe(128);
    expect(sourceCalls).toBe(0);

    expect(next.work(() => false)).toBe(true);
    expect(reads).toBe(count);
    expect(sourceCalls).toBe(1);
    expect(next.tree.nested).toHaveLength(1);
    expect(next.tree.nested[0]).not.toBe(reused);
    expect(next.tree.nested[0]!.tree).not.toBe(reused.tree);
    expect(next.tree.nested[0]!.tree.tree).toBe(reused.tree.tree);
  });

  it("reuses untouched native trees with independently owned wrappers", () => {
    let fixture = directReuseFixture("abcdefghij", [
      [{ from: 0, to: 1 }],
      [{ from: 2, to: 3 }],
      [{ from: 4, to: 5 }],
    ]);
    let firstGeneration = Array.from(fixture.context.tree.nested);
    fixture.nestedCalls.length = 0;

    let next = changedContext(fixture.context, fixture.state, 8, "Z");
    expect(next.context.work(() => false)).toBe(true);

    expect(fixture.nestedCalls).toEqual([]);
    expect(fixture.sourceCalls()).toBe(2);
    expect(next.context.tree.nested).toHaveLength(firstGeneration.length);
    for (let index = 0; index < firstGeneration.length; index++) {
      expect(next.context.tree.nested[index]).not.toBe(firstGeneration[index]);
      expect(next.context.tree.nested[index]!.tree).not.toBe(firstGeneration[index]!.tree);
      expect(next.context.tree.nested[index]!.tree.tree).toBe(firstGeneration[index]!.tree.tree);
    }
  });

  it("reparses only the exact group touched by an edit", () => {
    let fixture = directReuseFixture("abcdefghij", [
      [{ from: 0, to: 1 }],
      [{ from: 2, to: 3 }],
      [{ from: 4, to: 5 }],
    ]);
    let firstGeneration = Array.from(fixture.context.tree.nested);
    fixture.nestedCalls.length = 0;

    let next = changedContext(fixture.context, fixture.state, 2, "Z");
    expect(next.context.work(() => false)).toBe(true);

    expect(fixture.nestedCalls).toEqual(["2:3"]);
    expect(next.context.tree.nested[0]).not.toBe(firstGeneration[0]);
    expect(next.context.tree.nested[0]!.tree.tree).toBe(firstGeneration[0]!.tree.tree);
    expect(next.context.tree.nested[1]).not.toBe(firstGeneration[1]);
    expect(next.context.tree.nested[2]).not.toBe(firstGeneration[2]);
    expect(next.context.tree.nested[2]!.tree.tree).toBe(firstGeneration[2]!.tree.tree);
  });

  it("does not directly reuse groups across an externally invalidated reset", () => {
    let fixture = directReuseFixture("abcdef", [
      [{ from: 0, to: 1 }],
      [{ from: 2, to: 3 }],
      [{ from: 4, to: 5 }],
    ]);
    fixture.nestedCalls.length = 0;

    fixture.context.reset();
    expect(fixture.context.work(() => false)).toBe(true);

    expect(fixture.nestedCalls).toEqual(["0:1", "2:3", "4:5"]);
    expect(fixture.sourceCalls()).toBe(2);
  });

  it("invalidates pending reuse when an incomplete generation is reset", () => {
    let fixture = directReuseFixture("abcdefghij", [
      [{ from: 0, to: 1 }],
      [{ from: 2, to: 3 }],
      [{ from: 4, to: 5 }],
    ]);
    fixture.nestedCalls.length = 0;
    let next = changedContext(fixture.context, fixture.state, 2, "Z");

    expect(next.context.work(() => true)).toBe(false);
    next.context.reset();
    expect(next.context.work(() => false)).toBe(true);

    expect(fixture.nestedCalls).toEqual(["0:1", "2:3", "4:5"]);
  });

  it("rebuilds a missing second-level nested parser after reset", () => {
    let leafCalls: string[] = [];
    let leaf = fakeParser(({ ranges }) => {
      leafCalls.push(rangeGroupKey(ranges));
      return fakeTree("leaf");
    });
    let skipping = TreeSitterParser.getSkippingParser();
    let loaded = false;
    let parent = fakeParser(
      () => fakeTree("parent"),
      [
        {
          parser: () => (loaded ? leaf : skipping),
          ranges: () => [[{ from: 2, to: 3 }]],
        },
      ],
    );
    let root = fakeParser(
      () => fakeTree("root"),
      [{ parser: parent, ranges: () => [[{ from: 0, to: 5 }]] }],
    );
    let context = ParseContext.create(root, EditorState.create({ doc: "abcdef" }));

    expect(context.work(() => false)).toBe(true);
    expect(context.tree.nested[0]!.tree.nested).toHaveLength(0);
    expect(leafCalls).toEqual([]);

    loaded = true;
    context.reset();
    expect(context.work(() => false)).toBe(true);

    expect(leafCalls).toEqual(["2:3"]);
    expect(context.tree.nested[0]!.tree.nested).toHaveLength(1);
  });

  it("directly reuses 10,000 untouched groups without wall-clock assertions", () => {
    let count = 10_000;
    let groups = Array.from({ length: count }, (_, index) => [
      { from: index * 2, to: index * 2 + 1 },
    ]);
    let fixture = directReuseFixture("x".repeat(count * 2 + 2), groups);
    let firstGeneration = Array.from(fixture.context.tree.nested);
    fixture.nestedCalls.length = 0;
    let sourceCallsBefore = fixture.sourceCalls();

    let next = changedContext(fixture.context, fixture.state, count * 2, "Z");
    expect(next.context.work(() => false)).toBe(true);

    expect(fixture.nestedCalls).toHaveLength(0);
    expect(fixture.sourceCalls() - sourceCallsBefore).toBe(1);
    expect(next.context.tree.nested).toHaveLength(count);
    for (let index = 0; index < count; index++) {
      expect(next.context.tree.nested[index]).not.toBe(firstGeneration[index]);
      expect(next.context.tree.nested[index]!.tree.tree).toBe(firstGeneration[index]!.tree.tree);
    }
  });
});
