// @vitest-environment happy-dom

import { EditorState, RangeSet, Text, type RangeValue } from "@codemirror/state";
import { Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  type LeafAnalysisRecord,
  type LiveMdDescriptor,
  liveMdDescriptorKey,
} from "../src/core/analysis/descriptors.js";
import { type DocRange } from "../src/core/analysis/types.js";
import { liveMdLinkMark } from "../src/core/links.js";
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
import {
  joinProjectionSets,
  mapProjectionSets,
  projectionSetsFromLayer,
} from "../src/core/runtime/projection-state.js";
import { type MarkdownTable, TablePreviewWidget } from "../src/core/widgets.js";

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
  it("uses stable descriptor and table widget keys", () => {
    let tableDescriptor: Extract<LiveMdDescriptor, { kind: "table" }> = {
      delimiterRowRange: { from: 5, to: 10 },
      kind: "table",
      pipeRanges: [
        { from: 1, to: 2 },
        { from: 7, to: 8 },
      ],
      range: { from: 0, to: 20 },
      replacementRange: { block: true, from: 0, to: 20 },
      table: {
        alignments: ["left"],
        header: ["Alpha"],
        rows: [["One"]],
      },
    };
    let sameShapeDescriptor: Extract<LiveMdDescriptor, { kind: "table" }> = {
      ...tableDescriptor,
      table: {
        alignments: ["left"],
        header: ["Beta"],
        rows: [["Two"]],
      },
    };
    let differentShapeDescriptor: Extract<LiveMdDescriptor, { kind: "table" }> = {
      ...tableDescriptor,
      table: {
        alignments: ["left"],
        header: ["Alpha"],
        rows: [["One"], ["Two"]],
      },
    };
    expect(liveMdDescriptorKey(sameShapeDescriptor)).toBe(liveMdDescriptorKey(tableDescriptor));
    expect(liveMdDescriptorKey(differentShapeDescriptor)).not.toBe(
      liveMdDescriptorKey(tableDescriptor),
    );

    let nullLink: Extract<LiveMdDescriptor, { kind: "linkMark" }> = {
      destination: null,
      kind: "linkMark",
      range: { from: 0, to: 4 },
      sourceRange: { from: 0, to: 4 },
    };
    expect(liveMdDescriptorKey({ ...nullLink, destination: "" })).not.toBe(
      liveMdDescriptorKey(nullLink),
    );

    let table: MarkdownTable = {
      alignments: ["left"],
      header: ["Alpha"],
      rows: [["One"]],
    };
    expect(new TablePreviewWidget(table).eq(new TablePreviewWidget({ ...table }))).toBe(true);
    expect(
      new TablePreviewWidget(table).eq(
        new TablePreviewWidget({
          alignments: ["left"],
          header: ["Beta"],
          rows: [["Two"]],
        }),
      ),
    ).toBe(false);

    let richTable: MarkdownTable = {
      alignments: ["left"],
      header: ["**Alpha**"],
      headerCells: [
        {
          inline: [{ children: [{ kind: "text", text: "Alpha" }], kind: "strong" }],
          text: "**Alpha**",
        },
      ],
      rows: [],
      rowCells: [],
    };
    expect(
      new TablePreviewWidget(richTable).eq(
        new TablePreviewWidget({
          ...richTable,
          headerCells: [
            {
              inline: [{ children: [{ kind: "text", text: "Alpha" }], kind: "emphasis" }],
              text: "**Alpha**",
            },
          ],
        }),
      ),
    ).toBe(false);
  });

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
    expect(decorationRanges(build, projection.direct.decorations)).toEqual(
      decorationRanges(build, joinProjectionSets(projectionSetsFromLayer(projection.direct))),
    );
    expect(decorationRanges(build, projection.surface.decorations)).toEqual([
      { className: "surface-mark", from: 0, to: 3, widget: undefined },
      { className: undefined, from: 4, to: 7, widget: "TestWidget" },
      { className: "cm-md-syntax cm-md-syntax-hidden", from: 20, to: 23, widget: undefined },
    ]);
    expect(decorationRanges(build, projection.surface.decorations)).toEqual(
      decorationRanges(build, joinProjectionSets(projectionSetsFromLayer(projection.surface))),
    );
    expect(decorationRanges(build, mergedDecorations)).toEqual(decorationRanges(build));
    expect(atomicRanges(build, projection.direct.atomicRanges)).toEqual([
      { from: 8, to: 15 },
      { from: 16, to: 19 },
    ]);
    expect(atomicRanges(build, projection.surface.atomicRanges)).toEqual([{ from: 4, to: 7 }]);
    expect(atomicRanges(build, mergedAtomicRanges)).toEqual(atomicRanges(build));
  });

  it("maps exact replacement boundaries without changing block layout sides", () => {
    let blockBuild = testBuild("abc");
    addReplace(blockBuild, 0, 3, new TestWidget("block"), true);
    let blockProjection = finishProjectionLayers(blockBuild);
    let blockDecoration = onlyDecoration(blockProjection.direct.destructiveDecorations);

    expect(blockDecoration.spec).toMatchObject({
      block: true,
      inclusiveEnd: true,
      inclusiveStart: true,
    });

    let transaction = blockBuild.state.update({
      changes: [
        { from: 0, insert: "<" },
        { from: 3, insert: ">" },
      ],
    });
    let mapped = mapProjectionSets(
      projectionSetsFromLayer(blockProjection.direct),
      transaction.changes,
      [],
    );

    expect(
      decorationRanges({ ...blockBuild, state: transaction.state }, joinProjectionSets(mapped)),
    ).toEqual([{ className: undefined, from: 1, to: 4, widget: "TestWidget" }]);

    let inlineBuild = testBuild("abc");
    addReplace(inlineBuild, 0, 3, new TestWidget("inline"));
    let inlineDecoration = onlyDecoration(
      finishProjectionLayers(inlineBuild).surface.destructiveDecorations,
    );
    expect(inlineDecoration.spec).toMatchObject({
      block: false,
      inclusiveEnd: false,
      inclusiveStart: false,
    });
  });

  it("maps custom feature block replacement boundaries outside pending insertions", () => {
    let doc = "# Feature";
    let build = testBuild(doc);
    projectLeafRecords(build, [
      leafRecord(doc, [
        {
          effect: {
            atomic: true,
            block: true,
            kind: "replace",
            range: { from: 0, to: doc.length },
            widget: { key: "test-feature", widget: new TestWidget("feature") },
          },
          feature: "test-feature",
          kind: "feature",
        },
      ]),
    ]);
    let direct = projectionSetsFromLayer(finishProjectionLayers(build).direct);
    let transaction = build.state.update({
      changes: [
        { from: 0, insert: "<" },
        { from: doc.length, insert: ">" },
      ],
    });

    let mapped = mapProjectionSets(direct, transaction.changes, []);

    expect(
      decorationRanges({ ...build, state: transaction.state }, joinProjectionSets(mapped)),
    ).toEqual([{ className: undefined, from: 1, to: doc.length + 1, widget: "TestWidget" }]);
    expect(atomicRanges({ ...build, state: transaction.state }, mapped.atomicRanges)).toEqual([
      { from: 1, to: doc.length + 1 },
    ]);
  });

  it("keeps independently requested atomic range mapping semantics", () => {
    let build = testBuild("abc");
    addAtom(build, 0, 3);
    let direct = projectionSetsFromLayer(finishProjectionLayers(build).direct);
    let transaction = build.state.update({
      changes: [
        { from: 0, insert: "<" },
        { from: 3, insert: ">" },
      ],
    });

    let mapped = mapProjectionSets(direct, transaction.changes, []);

    expect(atomicRanges({ ...build, state: transaction.state }, mapped.atomicRanges)).toEqual([
      { from: 1, to: 5 },
    ]);
  });

  it("keeps interactive link marks in the visible surface layer", () => {
    let build = testBuild("[docs](https://example.com) and [plain]()");
    addMark(build, 1, 5, liveMdLinkMark("https://example.com", null));
    addMark(build, 33, 38, liveMdLinkMark(null, null));

    let projection = finishProjectionLayers(build);

    expect(linkHrefRanges(build, projection.interactiveDecorations)).toEqual([
      { from: 1, href: "https://example.com", to: 5 },
    ]);
    expect(linkHrefRanges(build, projection.surface.interactiveDecorations)).toEqual([
      { from: 1, href: "https://example.com", to: 5 },
    ]);
    expect(linkHrefRanges(build, projection.direct.decorations)).toEqual([]);
    expect(decorationRanges(build, projection.surface.sourceSafeDecorations)).toEqual([
      { className: "cm-md-link", from: 33, to: 38, widget: undefined },
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

function onlyDecoration(decorations: DecorationSet) {
  let values: Decoration[] = [];
  decorations.between(0, Number.MAX_SAFE_INTEGER, (_from, _to, value) => {
    values.push(value);
  });
  expect(values).toHaveLength(1);
  return values[0]!;
}

function linkHrefRanges(build: LiveMdBuild, decorations: DecorationSet) {
  let ranges: Array<{ from: number; href: string; to: number }> = [];
  decorations.between(0, build.state.doc.length, (from, to, value) => {
    let href = (value.spec as { attributes?: { "data-live-md-href"?: string } }).attributes?.[
      "data-live-md-href"
    ];
    if (href) ranges.push({ from, href, to });
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
    revealRange: options.sourceRange ?? range,
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
        replacementRange: { block: true, from: 0, to: doc.length },
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

it("maps only touched replacements and preserves exact mapping across multiple edits", () => {
  let build = testBuild("x".repeat(40_000));
  for (let from = 10; from < 40_000; from += 40) {
    addReplace(build, from, from + 20, new TestWidget(String(from)), true);
  }
  let direct = projectionSetsFromLayer(finishProjectionLayers(build).direct);
  let transaction = build.state.update({
    changes: [
      { from: 10, insert: "before" },
      { from: 20, to: 25, insert: "inside" },
      { from: 30, insert: "after" },
      { from: 50, to: 70, insert: "entire replacement" },
      { from: 15000, to: 15003 },
    ],
  });
  let expected: Array<{ from: number; to: number }> = [];
  direct.destructiveDecorations.between(0, build.state.doc.length, (from, to) => {
    let mappedFrom = transaction.changes.mapPos(from, 1);
    let mappedTo = transaction.changes.mapPos(to, -1);
    if (mappedFrom < mappedTo) expected.push({ from: mappedFrom, to: mappedTo });
  });
  let fullScans = 0;
  // oxlint-disable-next-line typescript/unbound-method -- explicit receiver supplied below
  let original = RangeSet.prototype.between;
  let spy = vi
    .spyOn(RangeSet.prototype, "between")
    .mockImplementation(function (this: RangeSet<RangeValue>, from, to, callback) {
      if (from === 0 && to >= build.state.doc.length) fullScans++;
      return original.call(this, from, to, callback);
    });
  let mapped;
  try {
    mapped = mapProjectionSets(direct, transaction.changes, []);
    expect(fullScans).toBe(0);
  } finally {
    spy.mockRestore();
  }
  let actual: Array<{ from: number; to: number }> = [];
  mapped.destructiveDecorations.between(0, transaction.state.doc.length, (from, to) => {
    actual.push({ from, to });
  });
  expect(actual.sort((a, b) => a.from - b.from)).toEqual(expected);
});
