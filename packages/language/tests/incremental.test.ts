import { ChangeSet, EditorState, RangeSet, RangeValue } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  clipToRanges,
  lineRangesForChanges,
  mergeDocRanges,
  patchRangeSet,
  rangesTouch,
} from "../src/incremental.js";

class TestValue extends RangeValue {
  constructor(readonly label: string) {
    super();
  }
}

describe("incremental range helpers", () => {
  it("maps text and syntax changes to merged touched line ranges", () => {
    let state = EditorState.create({ doc: "first\nsecond\nthird" });
    let changes = ChangeSet.of({ from: 1, to: 3, insert: "ir" }, state.doc.length);

    expect(lineRangesForChanges(state, changes, [{ from: 13, to: 18 }])).toEqual([
      { from: 0, to: 5 },
      { from: 13, to: 18 },
    ]);
  });

  it("clips ranges against visible ranges", () => {
    expect(
      clipToRanges(
        [
          { from: 0, to: 10 },
          { from: 20, to: 30 },
        ],
        [{ from: 5, to: 25 }],
      ),
    ).toEqual([
      { from: 5, to: 10 },
      { from: 20, to: 25 },
    ]);
  });

  it("patches only touched ranges in a range set", () => {
    let first = new TestValue("first");
    let second = new TestValue("second");
    let replacement = new TestValue("replacement");
    let ranges = RangeSet.of([first.range(0, 1), second.range(10, 11)], true);
    let patched = patchRangeSet(ranges, [{ from: 0, to: 5 }], [replacement.range(0, 2)]);
    let values: TestValue[] = [];

    patched.between(0, 20, (_from, _to, value) => {
      values.push(value);
    });

    expect(values).toEqual([replacement, second]);
  });

  it("uses point-aware range touching semantics", () => {
    expect(rangesTouch(5, 5, 0, 5)).toBe(false);
    expect(rangesTouch(5, 5, 0, 6)).toBe(true);
    expect(rangesTouch(0, 6, 5, 5)).toBe(true);
  });

  it("merges overlapping and adjacent document ranges", () => {
    expect(
      mergeDocRanges([
        { from: 10, to: 12 },
        { from: 0, to: 5 },
        { from: 5, to: 8 },
      ]),
    ).toEqual([
      { from: 0, to: 8 },
      { from: 10, to: 12 },
    ]);
  });
});
