import { type EditorState } from "@codemirror/state";
import { type SyntaxNode, type Tree } from "@codemirror-treesitter/language";
import { walkMarkdownBlocks } from "./markdown-block-cursor.js";
import {
  type MarkdownBlockContext,
  type MarkdownBlockSnapshot,
  type MarkdownLeaf,
  type MarkdownMarkerRecord,
} from "./markdown-block-types.js";
import {
  activeMarkdownSourceRanges,
  sourceIslandLeavesFromMarkdownSnapshot,
  type LiveMdSourceIslandLeaf,
} from "./markdown-source-islands.js";
import {
  type LeafAnalysis,
  type LeafAnalysisRecord,
  type LiveMdDescriptor,
} from "./descriptors.js";
import { analyzeMarkdownFenceDescriptor } from "./markdown-fence-analysis.js";
import {
  createMarkdownInlineAnalysisSession,
  type MarkdownInlineAnalysisSession,
} from "./markdown-inline-analysis.js";
import { analyzeMarkdownTableAnalysis } from "./markdown-table-analysis.js";
import {
  emptyLiveMdLeafAnalysisTrace,
  type DocRange,
  type LiveMdLeafAnalysisTrace,
} from "./types.js";
import { type LiveMdMarkdownParserService } from "../languages.js";

export type LiveMdLeafSemanticAnalysis = {
  activeSourceRanges: readonly DocRange[];
  records: readonly LeafAnalysisRecord[];
  sourceIslandLeaves: readonly LiveMdSourceIslandLeaf[];
  trace: LiveMdLeafAnalysisTrace;
};

export type LiveMdLeafSemanticAnalysisInput = {
  service: LiveMdMarkdownParserService;
  state: EditorState;
  tree: Tree;
};

export function analyzeMarkdownLeafSemantics(
  input: LiveMdLeafSemanticAnalysisInput,
): LiveMdLeafSemanticAnalysis {
  let walked = walkMarkdownBlocks(input.tree, input.state.doc);
  let trace = emptyLiveMdLeafAnalysisTrace();
  trace.blockNodesVisited = walked.trace.visitedBlockNodes;
  trace.recordsVisited = walked.snapshot.leaves.length + walked.snapshot.markers.length;
  let sourceIslandLeaves = sourceIslandLeavesFromMarkdownSnapshot(input.state.doc, walked.snapshot);
  let inlineSession = createMarkdownInlineAnalysisSession({
    blockTree: input.tree,
    doc: input.state.doc,
    service: input.service,
    trace,
  });
  let records: LeafAnalysisRecord[];
  try {
    records = analyzeSnapshotRecords(input, walked.snapshot, inlineSession, trace);
  } finally {
    inlineSession.dispose();
  }
  return {
    activeSourceRanges: activeMarkdownSourceRanges(input.state, sourceIslandLeaves),
    records,
    sourceIslandLeaves,
    trace,
  };
}

function analyzeSnapshotRecords(
  input: LiveMdLeafSemanticAnalysisInput,
  snapshot: MarkdownBlockSnapshot,
  inlineSession: MarkdownInlineAnalysisSession,
  trace: LiveMdLeafAnalysisTrace,
): LeafAnalysisRecord[] {
  let records: LeafAnalysisRecord[] = [];
  let problemSourceRanges: DocRange[] = [];
  for (let leaf of snapshot.leaves) {
    let hasProblem = hasProblemNode(leaf.node);
    if (hasProblem) problemSourceRanges.push(leaf.sourceRange);
    records.push(analyzeLeafRecord(input, leaf, hasProblem, inlineSession, trace));
    trace.recordsAnalyzed++;
  }
  for (let marker of snapshot.markers) {
    records.push(analyzeMarkerRecord(marker, problemSourceRanges));
    trace.recordsAnalyzed++;
  }
  return records.sort(compareRecords);
}

function analyzeLeafRecord(
  input: LiveMdLeafSemanticAnalysisInput,
  leaf: MarkdownLeaf,
  hasProblem: boolean,
  inlineSession: MarkdownInlineAnalysisSession,
  trace: LiveMdLeafAnalysisTrace,
): LeafAnalysisRecord {
  let structuralEffects = contextDescriptors(leaf.context, leaf.sourceRange);
  let descriptors = hasProblem ? [] : leafDescriptors(input, leaf, inlineSession, trace);
  return {
    analysis: leafAnalysis(leaf.kind, leaf.sourceRange, structuralEffects, descriptors),
    context: leaf.context,
    contextKey: leaf.contextKey,
    kind: leaf.kind,
    range: leaf.range,
    sourceRange: leaf.sourceRange,
  };
}

function analyzeMarkerRecord(
  marker: MarkdownMarkerRecord,
  problemSourceRanges: readonly DocRange[],
): LeafAnalysisRecord {
  let sourceSafeOnly = hasOverlappingProblemSourceRange(marker.lineRange, problemSourceRanges);
  let structuralEffects = markerDescriptors(marker, sourceSafeOnly);
  return {
    analysis: leafAnalysis("marker", marker.lineRange, structuralEffects, []),
    context: marker.context,
    contextKey: marker.contextKey,
    kind: "marker",
    range: marker.range,
    sourceRange: marker.lineRange,
  };
}

function leafDescriptors(
  input: LiveMdLeafSemanticAnalysisInput,
  leaf: MarkdownLeaf,
  inlineSession: MarkdownInlineAnalysisSession,
  trace: LiveMdLeafAnalysisTrace,
): LiveMdDescriptor[] {
  switch (leaf.kind) {
    case "paragraph":
      return leafInlineDescriptors(inlineSession, leaf);
    case "heading":
      return [...headingDescriptors(leaf.node), ...headingInlineDescriptors(inlineSession, leaf)];
    case "table": {
      let table = analyzeMarkdownTableAnalysis(input.state.doc, input.tree, leaf.range);
      trace.tableCellsParsed += table.inlineRanges.length;
      return dedupeDescriptors([
        ...(table.descriptor ? [table.descriptor] : []),
        ...table.inlineRanges.flatMap((range) => inlineSession.analyze(range)),
      ]);
    }
    case "fencedCode": {
      let fence = analyzeMarkdownFenceDescriptor(input.state.doc, leaf.node);
      return fence ? [fence] : [];
    }
    case "rule":
      return [
        { className: "cm-md-rule-line", kind: "lineClass", range: leaf.range },
        { kind: "syntax", range: leaf.range },
      ];
    case "html":
    case "indentedCode":
      return [];
  }
}

function headingInlineDescriptors(
  inlineSession: MarkdownInlineAnalysisSession,
  leaf: MarkdownLeaf,
): LiveMdDescriptor[] {
  if (leaf.node.name != "setext_heading") return leafInlineDescriptors(inlineSession, leaf);
  let content = setextHeadingContentParagraph(leaf.node);
  if (!content) return [];
  return inlineSession.analyze(nodeRange(content));
}

function leafInlineDescriptors(
  inlineSession: MarkdownInlineAnalysisSession,
  leaf: MarkdownLeaf,
): LiveMdDescriptor[] {
  let descriptors = inlineSession.analyze(leaf.range);
  if (leaf.sourceRange.from != leaf.range.from || leaf.sourceRange.to != leaf.range.to) {
    descriptors = dedupeDescriptors([...descriptors, ...inlineSession.analyze(leaf.sourceRange)]);
  }
  return descriptors;
}

function setextHeadingContentParagraph(node: SyntaxNode): SyntaxNode | null {
  let content = node.childForFieldName("heading_content");
  if (content?.name == "paragraph") return content;
  return node.children.find((child) => child.name == "paragraph") ?? null;
}

function headingDescriptors(node: SyntaxNode): LiveMdDescriptor[] {
  let marker = headingMarker(node);
  let level = marker ? headingLevel(marker) : 1;
  let descriptors: LiveMdDescriptor[] = [
    { className: "cm-md-heading", kind: "lineClass", range: nodeRange(node) },
    { className: `cm-md-heading-${level}`, kind: "lineClass", range: nodeRange(node) },
  ];
  if (marker) descriptors.push({ kind: "syntax", range: nodeRange(marker) });
  return descriptors;
}

function headingMarker(node: SyntaxNode) {
  return (
    node.children.find(
      (child) => child.name.startsWith("atx_h") && child.name.endsWith("_marker"),
    ) ??
    node.children.find((child) => child.name == "setext_h1_underline") ??
    node.children.find((child) => child.name == "setext_h2_underline") ??
    null
  );
}

function headingLevel(marker: SyntaxNode) {
  if (marker.name == "setext_h1_underline") return 1;
  if (marker.name == "setext_h2_underline") return 2;
  let match = /^atx_h([1-6])_marker$/.exec(marker.name);
  return match ? Number(match[1]) : 1;
}

function contextDescriptors(
  context: MarkdownBlockContext,
  sourceRange: DocRange,
): LiveMdDescriptor[] {
  let descriptors: LiveMdDescriptor[] = [];
  if (context.quoteDepth > 0) {
    descriptors.push({ className: "cm-md-blockquote", kind: "lineClass", range: sourceRange });
  }
  for (let item of context.listPath) {
    descriptors.push({ className: "cm-md-list-line", kind: "lineClass", range: item.itemRange });
  }
  return descriptors;
}

function markerDescriptors(
  marker: MarkdownMarkerRecord,
  sourceSafeOnly = false,
): LiveMdDescriptor[] {
  let descriptors: LiveMdDescriptor[] = [];
  if (marker.context.quoteDepth > 0) {
    descriptors.push({
      className: "cm-md-blockquote",
      kind: "lineClass",
      range: marker.lineRange,
    });
  }

  switch (marker.kind) {
    case "listMarker":
      descriptors.push({
        className: "cm-md-list-line",
        kind: "lineClass",
        range: marker.lineRange,
      });
      if (!sourceSafeOnly) {
        descriptors.push({
          kind: "listMarker",
          marker: marker.text.trim(),
          range: marker.range,
        });
      }
      break;
    case "taskMarker":
      descriptors.push({
        className: "cm-md-list-line",
        kind: "lineClass",
        range: marker.lineRange,
      });
      descriptors.push({
        className: "cm-md-task-line",
        kind: "lineClass",
        range: marker.lineRange,
      });
      if (marker.text.includes("x") || marker.text.includes("X")) {
        descriptors.push({ className: "is-checked", kind: "lineClass", range: marker.lineRange });
      }
      if (!sourceSafeOnly) {
        descriptors.push({
          checked: marker.text.includes("x") || marker.text.includes("X"),
          kind: "taskMarker",
          range: marker.range,
        });
      }
      break;
    case "continuation":
    case "quoteMarker":
      if (!sourceSafeOnly) descriptors.push({ kind: "syntax", range: marker.range });
      break;
  }
  return descriptors;
}

function leafAnalysis(
  kind: string,
  range: DocRange,
  structuralEffects: readonly LiveMdDescriptor[],
  descriptors: readonly LiveMdDescriptor[],
): LeafAnalysis {
  let key = stableAnalysisKey(kind, range, structuralEffects, descriptors);
  return {
    analysisKey: key,
    descriptors,
    renderKey: key,
    structuralEffects,
  };
}

function stableAnalysisKey(
  kind: string,
  range: DocRange,
  structuralEffects: readonly LiveMdDescriptor[],
  descriptors: readonly LiveMdDescriptor[],
) {
  return hashString(JSON.stringify([kind, range, structuralEffects, descriptors]));
}

function hashString(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function hasProblemNode(node: SyntaxNode): boolean {
  return node.hasError || node.isMissing;
}

function hasOverlappingProblemSourceRange(
  range: DocRange,
  problemSourceRanges: readonly DocRange[],
) {
  return problemSourceRanges.some((problemRange) => rangesOverlap(range, problemRange));
}

function rangesOverlap(left: DocRange, right: DocRange) {
  return left.from < right.to && right.from < left.to;
}

function compareRecords(left: LeafAnalysisRecord, right: LeafAnalysisRecord) {
  return (
    left.range.from - right.range.from ||
    left.range.to - right.range.to ||
    left.kind.localeCompare(right.kind)
  );
}

function nodeRange(node: SyntaxNode): DocRange {
  return { from: node.from, to: node.to };
}

function dedupeDescriptors(descriptors: readonly LiveMdDescriptor[]) {
  let deduped: LiveMdDescriptor[] = [];
  let seen = new Set<string>();
  for (let descriptor of descriptors) {
    let key = JSON.stringify(descriptor);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(descriptor);
  }
  return deduped;
}
