// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { describe, expect, it } from "vite-plus/test";
import {
  addAtom,
  addLineClass,
  addMark,
  addReplace,
  addSyntax,
  createLiveMdBuild,
  finishAtomicRanges,
  finishDecorations,
} from "../src/core/projection/emit.js";
import { type LiveMdBuild } from "../src/core/analysis/types.js";

class TestWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  eq(other: TestWidget) {
    return other.label == this.label;
  }

  toDOM() {
    let element = document.createElement("span");
    element.textContent = this.label;
    return element;
  }
}

describe("LiveMD projection effects", () => {
  it("materializes effects in stable document order", () => {
    let build = testBuild("one\ntwo\nthree");
    addMark(build, 8, 13, Decoration.mark({ class: "late" }));
    addReplace(build, 0, 3, new TestWidget("early"), false, true);
    addSyntax(build, 4, 7, Decoration.mark({ class: "middle" }));
    addAtom(build, 8, 13);

    expect(decorationRanges(build)).toEqual([
      { className: undefined, from: 0, to: 3, widget: "TestWidget" },
      { className: "middle", from: 4, to: 7, widget: undefined },
      { className: "late", from: 8, to: 13, widget: undefined },
    ]);
    expect(atomicRanges(build)).toEqual([
      { from: 0, to: 3 },
      { from: 8, to: 13 },
    ]);
  });

  it("deduplicates line classes per line while preserving line order", () => {
    let build = testBuild("one\ntwo\nthree");
    addLineClass(build, 3, "tail");
    addLineClass(build, 1, "lead");
    addLineClass(build, 1, "lead");
    addLineClass(build, 1, "strong");

    expect(decorationRanges(build)).toEqual([
      { className: "lead strong", from: 0, to: 0, widget: undefined },
      { className: "tail", from: 8, to: 8, widget: undefined },
    ]);
  });

  it("treats replace.atomic as equivalent to explicit atomic ranges", () => {
    let build = testBuild("abcdef");
    addReplace(build, 1, 3, new TestWidget("replace"), false, true);
    addAtom(build, 1, 3);
    addAtom(build, 1, 3);
    addAtom(build, 2, 4);

    expect(atomicRanges(build)).toEqual([
      { from: 1, to: 3 },
      { from: 2, to: 4 },
    ]);
  });

  it("keeps window materialization equivalent to the same full-build window", () => {
    let full = testBuild("alpha\nbeta\ngamma");
    addMark(full, 0, 5, Decoration.mark({ class: "outside-before" }));
    addMark(full, 6, 10, Decoration.mark({ class: "inside" }));
    addReplace(full, 11, 16, new TestWidget("outside-after"), true, true);

    let windowed = {
      ...testBuild(full.state.doc.toString()),
      effects: full.effects.filter((effect) => effect.from >= 6 && effect.to <= 10),
    };

    expect(decorationRanges(windowed)).toEqual(
      decorationRanges(full).filter((range) => range.from >= 6 && range.to <= 10),
    );
    expect(atomicRanges(windowed)).toEqual(
      atomicRanges(full).filter((range) => range.from >= 6 && range.to <= 10),
    );
  });
});

function testBuild(doc: string): LiveMdBuild {
  return createLiveMdBuild({
    activeLines: new Set([2]),
    codeFenceHighlighters: [],
    codeFenceLanguages: new Map(),
    imageSourceResolver: null,
    linkBaseUrl: null,
    markdownFeatures: [],
    state: EditorState.create({ doc }),
  });
}

function decorationRanges(build: LiveMdBuild) {
  let ranges: Array<{
    className: string | undefined;
    from: number;
    to: number;
    widget: string | undefined;
  }> = [];
  finishDecorations(build).between(0, build.state.doc.length, (from, to, value) => {
    let spec = value.spec as { class?: string; widget?: unknown };
    let widget = spec.widget;
    ranges.push({
      className: spec.class,
      from,
      to,
      widget: widget && typeof widget == "object" ? widget.constructor.name : undefined,
    });
  });
  return ranges;
}

function atomicRanges(build: LiveMdBuild) {
  let ranges: Array<{ from: number; to: number }> = [];
  finishAtomicRanges(build).between(0, build.state.doc.length, (from, to) => {
    ranges.push({ from, to });
  });
  return ranges;
}
