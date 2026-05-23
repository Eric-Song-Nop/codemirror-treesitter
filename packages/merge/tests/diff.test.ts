import { describe, expect, it } from "vite-plus/test";
import { Change, diff, presentableDiff } from "../src/index.js";

function apply(diff: readonly Change[], orig: string, changed: string) {
  let pos = 0;
  let result = "";
  for (let ch of diff) {
    result += orig.slice(pos, ch.fromA);
    result += changed.slice(ch.fromB, ch.toB);
    pos = ch.toA;
  }
  return result + orig.slice(pos);
}

function serializeDiff(diff: readonly Change[], a: string, b: string) {
  let posA = 0;
  let result = "";
  for (let ch of diff) {
    result += `${a.slice(posA, ch.fromA)}[${a.slice(ch.fromA, ch.toA)}/${b.slice(
      ch.fromB,
      ch.toB,
    )}]`;
    posA = ch.toA;
  }
  return result + a.slice(posA);
}

function parseDiff(diff: string) {
  let change = /\[(.*?)\/(.*?)\]/g;
  return {
    a: diff.replace(change, (_match, a: string) => a),
    b: diff.replace(change, (_match, _a: string, b: string) => b),
  };
}

describe("merge diff", () => {
  it("computes applicable changes without splitting surrogate pairs", () => {
    for (let [a, b] of [
      ["one two three", "one twi three"],
      ["🐶", "🐯"],
      ["🍏🍎", "🍎"],
      ["x🍎", "x🍏🍎"],
    ]) {
      let changes = diff(a, b);
      expect(apply(changes, a, b)).toBe(b);
      for (let change of changes) {
        expect(a.slice(change.fromA, change.toA)).not.toMatch(/[\ud800-\udbff]$/);
        expect(b.slice(change.fromB, change.toB)).not.toMatch(/[\ud800-\udbff]$/);
      }
    }
  });

  it("keeps presentable diffs aligned to useful word and line boundaries", () => {
    for (let sample of [
      "one [two/twi] three",
      "[drop/drip]",
      " x,\n[/ y,]\n z,\n",
      " x,\n[ y,/]\n z,\n",
    ]) {
      let { a, b } = parseDiff(sample);
      let changes = presentableDiff(a, b);
      expect(serializeDiff(changes, a, b)).toBe(sample);
      expect(apply(changes, a, b)).toBe(b);
    }
  });
});
