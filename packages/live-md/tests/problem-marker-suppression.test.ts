import { EditorState, Text } from "@codemirror/state";
import { loadMarkdownParserService } from "@codemirror-treesitter/language-data";
import { describe, expect, it } from "vite-plus/test";
import {
  type LeafAnalysisRecord,
  type LiveMdDescriptor,
} from "../src/core/analysis/descriptors.js";
import { analyzeMarkdownLeafSemantics } from "../src/core/analysis/markdown-leaf-analysis.js";
import { deleteLiveMdTree } from "../src/core/languages.js";
import { projectLeaf } from "../src/core/projection/project-leaf.js";
import { type LiveMdEffectSpec, type LiveMdRenderStatus } from "../src/core/projection/types.js";

describe("LiveMD problem marker suppression", () => {
  it("keeps malformed list-contained table markers source-safe when inactive", async () => {
    let doc = "- | a | b |\n  | --- | ---\n  ||";
    let records = await analyzeRecords(doc);
    let markerRecord = records.find((record) => record.kind == "marker");
    let specs = inactiveSpecs(doc, records);

    expect(problemTableRecord(records)?.analysis.descriptors).toEqual([]);
    expect(markerRecord?.analysis.structuralEffects.map(descriptorKey)).toEqual([
      "lineClass:cm-md-list-line",
    ]);
    expect(hasLineClass(specs, "cm-md-list-line")).toBe(true);
    expect(hasWidgetReplacement(specs, "listMarker")).toBe(false);
  });

  it("keeps malformed quote-contained table markers source-safe when inactive", async () => {
    let doc = "> | a | b |\n> | --- | ---\n> ||";
    let records = await analyzeRecords(doc);
    let markerRecords = records.filter((record) => record.kind == "marker");
    let specs = inactiveSpecs(doc, records);

    expect(problemTableRecord(records)?.analysis.descriptors).toEqual([]);
    expect(markerRecords).toHaveLength(3);
    expect(
      markerRecords.every((record) =>
        record.analysis.structuralEffects.every(
          (descriptor) =>
            descriptor.kind == "lineClass" && descriptor.className == "cm-md-blockquote",
        ),
      ),
    ).toBe(true);
    expect(hasLineClass(specs, "cm-md-blockquote")).toBe(true);
    expect(specs.some((spec) => spec.kind == "syntax")).toBe(false);
  });
});

async function analyzeRecords(doc: string): Promise<LeafAnalysisRecord[]> {
  let service = await loadMarkdownParserService();
  let state = EditorState.create({ doc });
  let tree = service.blockParser.parse(state.doc);
  try {
    return [...analyzeMarkdownLeafSemantics({ service, state, tree }).records];
  } finally {
    deleteLiveMdTree(tree);
  }
}

function inactiveSpecs(
  doc: string,
  records: readonly LeafAnalysisRecord[],
): readonly LiveMdEffectSpec[] {
  let status = renderStatus(doc);
  return records.flatMap((record) => [...projectLeaf(record, false, status)]);
}

function renderStatus(doc: string): LiveMdRenderStatus {
  return {
    activeLines: new Set(),
    activeSource: false,
    activeSourceRanges: [],
    doc: Text.of(doc.split("\n")),
    sourceIslandMode: true,
  };
}

function problemTableRecord(records: readonly LeafAnalysisRecord[]) {
  return records.find(
    (record) => record.kind == "table" && record.analysis.descriptors.length == 0,
  );
}

function descriptorKey(descriptor: LiveMdDescriptor) {
  return descriptor.kind == "lineClass" ? `lineClass:${descriptor.className}` : descriptor.kind;
}

function hasLineClass(specs: readonly LiveMdEffectSpec[], className: string) {
  return specs.some((spec) => spec.kind == "lineClass" && spec.className == className);
}

function hasWidgetReplacement(
  specs: readonly LiveMdEffectSpec[],
  kind: "listMarker" | "taskMarker",
) {
  return specs.some((spec) => spec.kind == "replace" && spec.widget.kind == kind);
}
