// @vitest-environment happy-dom

import { EditorState, RangeSet, Text, type RangeValue } from "@codemirror/state";
import { Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vite-plus/test";
import {
  type LeafAnalysisRecord,
  type LiveMdDescriptor,
} from "../src/core/analysis/descriptors.js";
import { type DocRange } from "../src/core/analysis/types.js";
import {
  addAtom,
  addLineClass,
  addMark,
  addReplace,
  addSyntax,
  createLiveMdBuild,
  finishAtomicRanges,
  finishDecorations,
  finishProjectionLayers,
} from "../src/core/projection/emit.js";
import { projectLeaf, projectLeafRecords } from "../src/core/projection/project-leaf.js";
import { type LiveMdBuild, type LiveMdRenderStatus } from "../src/core/projection/types.js";

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

  it("splits direct layout effects from visible surface effects", () => {
    let build = testBuild("aaa\nbbb\nccc\nddd\neee\nfff");
    addMark(build, 0, 3, Decoration.mark({ class: "surface-mark" }));
    addReplace(build, 4, 7, new TestWidget("surface-inline"), false, true);
    addReplace(build, 8, 15, new TestWidget("direct-cross-line"), false, true);
    addReplace(build, 16, 19, new TestWidget("direct-block"), true, true);
    addLineClass(build, 2, "direct-line");
    addSyntax(build, 20, 23);

    let projection = finishProjectionLayers(build);
    let mergedDecorations = RangeSet.join([
      projection.direct.decorations,
      projection.surface.decorations,
    ]);
    let mergedAtomicRanges = RangeSet.join([
      projection.direct.atomicRanges,
      projection.surface.atomicRanges,
    ]);

    expect(decorationRanges(build, projection.direct.decorations)).toEqual([
      { className: "direct-line", from: 4, to: 4, widget: undefined },
      { className: undefined, from: 8, to: 15, widget: "TestWidget" },
      { className: undefined, from: 16, to: 19, widget: "TestWidget" },
    ]);
    expect(decorationRanges(build, projection.surface.decorations)).toEqual([
      { className: "surface-mark", from: 0, to: 3, widget: undefined },
      { className: undefined, from: 4, to: 7, widget: "TestWidget" },
      { className: "cm-md-syntax cm-md-syntax-hidden", from: 20, to: 23, widget: undefined },
    ]);
    expect(decorationRanges(build, mergedDecorations)).toEqual(decorationRanges(build));
    expect(atomicRanges(build, projection.direct.atomicRanges)).toEqual([
      { from: 8, to: 15 },
      { from: 16, to: 19 },
    ]);
    expect(atomicRanges(build, projection.surface.atomicRanges)).toEqual([{ from: 4, to: 7 }]);
    expect(atomicRanges(build, mergedAtomicRanges)).toEqual(atomicRanges(build));
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

  it("projects editable leaf markers as source-safe specs instead of replacements", () => {
    let doc = "- item\n\nnext";
    let record = leafRecord(doc, [
      { className: "cm-md-list-line", kind: "lineClass", range: { from: 0, to: 6 } },
      { kind: "listMarker", marker: "-", range: { from: 0, to: 1 } },
    ]);

    expect(projectLeaf(record, false, renderStatus(doc))).toEqual([
      { className: "cm-md-list-line", from: 0, kind: "lineClass", to: 6 },
      { from: 0, kind: "replace", to: 1, widget: { kind: "listMarker", marker: "-" } },
    ]);
    expect(projectLeaf(record, true, renderStatus(doc))).toEqual([
      { className: "cm-md-list-line", from: 0, kind: "lineClass", to: 6 },
      { from: 0, kind: "syntax", to: 1 },
    ]);
  });

  it("skips table cell inline specs when an inactive table is replaced", () => {
    let doc = "| A | B |\n| - | - |\n| **x** | y |";
    let bold = docRange(doc, "**x**");
    let record = tableRecord(doc, [{ kind: "textMark", mark: "strong", range: bold }]);
    let specs = projectLeaf(record, false, renderStatus(doc));

    expect(specs).toEqual([
      {
        block: true,
        from: 0,
        kind: "replace",
        to: doc.length,
        widget: {
          kind: "tablePreview",
          table: { alignments: ["default", "default"], header: ["A", "B"], rows: [["x", "y"]] },
        },
      },
    ]);
  });

  it("keeps table cell inline specs for active source tables", () => {
    let doc = "| A | B |\n| - | - |\n| **x** | y |";
    let bold = docRange(doc, "**x**");
    let record = tableRecord(doc, [{ kind: "textMark", mark: "strong", range: bold }]);
    let specs = projectLeaf(
      record,
      false,
      renderStatus(doc, { activeSource: true, activeSourceRanges: [{ from: 0, to: doc.length }] }),
    );

    expect(specs.some((spec) => spec.kind == "replace")).toBe(false);
    expect(specs).toContainEqual({
      className: "cm-md-table-line",
      from: 0,
      kind: "lineClass",
      to: doc.length,
    });
    expect(specs).toContainEqual({
      from: bold.from,
      kind: "mark",
      mark: { kind: "text", mark: "strong" },
      to: bold.to,
    });
  });

  it("materializes leaf specs through the build adapter", () => {
    let doc = "- item\n\nnext";
    let build = testBuild(doc, { sourceIslandMode: true });
    projectLeafRecords(build, [
      leafRecord(doc, [{ kind: "listMarker", marker: "-", range: { from: 0, to: 1 } }], {
        kind: "marker",
        range: { from: 0, to: 1 },
        sourceRange: { from: 0, to: 6 },
      }),
    ]);

    expect(decorationRanges(build)).toEqual([
      { className: undefined, from: 0, to: 1, widget: "ListMarkerWidget" },
    ]);
  });
});

function testBuild(
  doc: string,
  options: {
    activeLines?: Set<number>;
    activeSourceRanges?: readonly DocRange[];
    sourceIslandMode?: boolean;
  } = {},
): LiveMdBuild {
  let config = {
    activeLines: options.activeLines ?? new Set([2]),
    codeFenceHighlighters: [],
    codeFenceLanguages: new Map(),
    imageSourceResolver: null,
    linkBaseUrl: null,
    markdownFeatures: [],
    state: EditorState.create({ doc }),
  };
  return createLiveMdBuild({
    ...config,
    ...(options.activeSourceRanges ? { activeSourceRanges: options.activeSourceRanges } : {}),
    ...(options.sourceIslandMode == null ? {} : { sourceIslandMode: options.sourceIslandMode }),
  });
}

function decorationRanges(
  build: LiveMdBuild,
  decorations: DecorationSet = finishDecorations(build),
) {
  let ranges: Array<{
    className: string | undefined;
    from: number;
    to: number;
    widget: string | undefined;
  }> = [];
  decorations.between(0, build.state.doc.length, (from, to, value) => {
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

function renderStatus(
  doc: string,
  options: {
    activeLines?: ReadonlySet<number>;
    activeSource?: boolean;
    activeSourceRanges?: readonly DocRange[];
    sourceIslandMode?: boolean;
  } = {},
): LiveMdRenderStatus {
  return {
    activeLines: options.activeLines ?? new Set(),
    activeSource: options.activeSource ?? false,
    activeSourceRanges: options.activeSourceRanges ?? [],
    doc: Text.of(doc.split("\n")),
    sourceIslandMode: options.sourceIslandMode ?? true,
  };
}

function leafRecord(
  doc: string,
  descriptors: readonly LiveMdDescriptor[],
  options: {
    kind?: LeafAnalysisRecord["kind"];
    range?: DocRange;
    sourceRange?: DocRange;
    structuralEffects?: readonly LiveMdDescriptor[];
  } = {},
): LeafAnalysisRecord {
  let range = options.range ?? { from: 0, to: doc.length };
  return {
    analysis: {
      analysisKey: "test",
      descriptors,
      renderKey: "test",
      structuralEffects: options.structuralEffects ?? [],
    },
    cacheId: 1,
    context: { listPath: [], quoteDepth: 0, quoteMarkers: [] },
    contextKey: "test",
    effectRange: options.sourceRange ?? range,
    kind: options.kind ?? "paragraph",
    range,
    sourceHash: 0,
    sourceRange: options.sourceRange ?? range,
    structuralKey: "test",
  };
}

function tableRecord(
  doc: string,
  cellDescriptors: readonly LiveMdDescriptor[] = [],
): LeafAnalysisRecord {
  let delimiterFrom = doc.indexOf("| - | - |");
  let pipes = pipeRanges(doc);
  return leafRecord(
    doc,
    [
      {
        delimiterRowRange: { from: delimiterFrom, to: delimiterFrom + "| - | - |".length },
        kind: "table",
        pipeRanges: pipes,
        range: { from: 0, to: doc.length },
        table: {
          alignments: ["default", "default"],
          header: ["A", "B"],
          rows: [["x", "y"]],
        },
      },
      ...cellDescriptors,
    ],
    { kind: "table" },
  );
}

function docRange(doc: string, text: string): DocRange {
  let from = doc.indexOf(text);
  if (from < 0) throw new Error(`Missing test text: ${text}`);
  return { from, to: from + text.length };
}

function pipeRanges(doc: string): DocRange[] {
  let ranges: DocRange[] = [];
  for (let index = 0; index < doc.length; index++) {
    if (doc[index] == "|") ranges.push({ from: index, to: index + 1 });
  }
  return ranges;
}

function atomicRanges(
  build: LiveMdBuild,
  rangeSet: RangeSet<RangeValue> = finishAtomicRanges(build),
) {
  let ranges: Array<{ from: number; to: number }> = [];
  rangeSet.between(0, build.state.doc.length, (from, to) => {
    ranges.push({ from, to });
  });
  return ranges.sort((left, right) => left.from - right.from || left.to - right.to);
}
