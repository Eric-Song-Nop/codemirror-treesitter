import { EditorState, type Text } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { ParseContext, Tree, TreeSitterParser, type DocRange } from "../src/index.js";
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
});

describe("incremental nested direct reuse", () => {
  it("reuses untouched exact groups in FIFO order without calling nested parseWith", () => {
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
      expect(next.context.tree.nested[index]).toBe(firstGeneration[index]);
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
    expect(next.context.tree.nested[0]).toBe(firstGeneration[0]);
    expect(next.context.tree.nested[1]).not.toBe(firstGeneration[1]);
    expect(next.context.tree.nested[2]).toBe(firstGeneration[2]);
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

  it("preserves pending changed ranges when an incomplete generation is reset", () => {
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
      expect(next.context.tree.nested[index]).toBe(firstGeneration[index]);
    }
  });
});
