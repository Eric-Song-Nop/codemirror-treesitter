import { type EditorState, type Text } from "@codemirror/state";
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
  liveMdDescriptorRanges,
  offsetLiveMdDescriptors,
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
  inlineSession?: MarkdownInlineAnalysisSession;
  renderKeyContext?: LiveMdRenderKeyContext;
  service: LiveMdMarkdownParserService;
  state: EditorState;
  tree: Tree;
};

export type LiveMdRenderKeyContext = {
  referenceEpoch: number;
  rendererVersion: string;
  resolverEpoch: number;
  themeEpoch: number;
};

export const liveMdRendererVersion = "live-md-renderer-v1";

export const defaultLiveMdRenderKeyContext: LiveMdRenderKeyContext = Object.freeze({
  referenceEpoch: 0,
  rendererVersion: liveMdRendererVersion,
  resolverEpoch: 0,
  themeEpoch: 0,
});

export type MarkdownLeafAnalysisUnit =
  | {
      cacheSourceHash: number;
      cacheSourceRange: DocRange;
      cacheStructuralKey: string;
      context: MarkdownBlockContext;
      contextKey: string;
      kind: MarkdownLeaf["kind"];
      leaf: MarkdownLeaf;
      range: DocRange;
      sourceHash: number;
      sourceRange: DocRange;
      structuralKey: string;
      structuralEffects: readonly LiveMdDescriptor[];
      type: "leaf";
    }
  | {
      cacheSourceHash: number;
      cacheSourceRange: DocRange;
      cacheStructuralKey: string;
      context: MarkdownBlockContext;
      contextKey: string;
      kind: "marker";
      marker: MarkdownMarkerRecord;
      range: DocRange;
      sourceHash: number;
      sourceRange: DocRange;
      structuralKey: string;
      structuralEffects: readonly LiveMdDescriptor[];
      type: "marker";
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
    records = analyzeSnapshotRecords({ ...input, inlineSession }, walked.snapshot, 1, trace);
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

export function analyzeSnapshotRecords(
  input: LiveMdLeafSemanticAnalysisInput,
  snapshot: MarkdownBlockSnapshot,
  startCacheId = 1,
  trace: LiveMdLeafAnalysisTrace = emptyLiveMdLeafAnalysisTrace(),
): LeafAnalysisRecord[] {
  let inlineSession =
    input.inlineSession ??
    createMarkdownInlineAnalysisSession({
      blockTree: input.tree,
      doc: input.state.doc,
      service: input.service,
      trace,
    });
  let analysisInput = input.inlineSession ? input : { ...input, inlineSession };
  let records: LeafAnalysisRecord[] = [];
  let nextCacheId = startCacheId;
  let units = markdownLeafAnalysisUnits(input.state.doc, snapshot);
  trace.recordsVisited = units.length;
  try {
    for (let unit of units) {
      records.push(analyzeMarkdownLeafAnalysisUnit(analysisInput, unit, nextCacheId++, trace));
      trace.recordsAnalyzed++;
    }
  } finally {
    if (!input.inlineSession) inlineSession.dispose();
  }
  return records;
}

export function markdownLeafAnalysisUnits(
  doc: Text,
  snapshot: MarkdownBlockSnapshot,
): MarkdownLeafAnalysisUnit[] {
  let units: MarkdownLeafAnalysisUnit[] = [];
  let problemSourceRanges = snapshot.leaves
    .filter((leaf) => hasProblemNode(leaf.node))
    .map((leaf) => leaf.sourceRange);
  for (let leaf of snapshot.leaves) {
    let structuralEffects = relativeDescriptors(
      contextDescriptors(leaf.context, leaf.sourceRange),
      leaf.sourceRange,
    );
    let structuralKey = descriptorKey(structuralEffects);
    let sourceHash = hashDocRange(doc, leaf.sourceRange);
    units.push({
      cacheSourceHash: sourceHash,
      cacheSourceRange: leaf.sourceRange,
      cacheStructuralKey: structuralKey,
      context: leaf.context,
      contextKey: leaf.contextKey,
      kind: leaf.kind,
      leaf,
      range: leaf.range,
      sourceHash,
      sourceRange: leaf.sourceRange,
      structuralKey,
      structuralEffects,
      type: "leaf",
    });
  }
  for (let marker of snapshot.markers) {
    let sourceSafeOnly = hasOverlappingProblemSourceRange(marker.lineRange, problemSourceRanges);
    let structuralEffects = relativeDescriptors(
      markerDescriptors(marker, sourceSafeOnly),
      marker.lineRange,
    );
    let structuralKey = descriptorKey(structuralEffects);
    units.push({
      cacheSourceHash: hashDocRange(doc, marker.range),
      cacheSourceRange: marker.range,
      cacheStructuralKey: markerCacheStructuralKey(marker, sourceSafeOnly),
      context: marker.context,
      contextKey: marker.contextKey,
      kind: "marker",
      marker,
      range: marker.range,
      sourceHash: hashDocRange(doc, marker.lineRange),
      sourceRange: marker.lineRange,
      structuralKey,
      structuralEffects,
      type: "marker",
    });
  }
  return units.sort(compareUnits);
}

export function analyzeMarkdownLeafAnalysisUnit(
  input: LiveMdLeafSemanticAnalysisInput,
  unit: MarkdownLeafAnalysisUnit,
  cacheId: number,
  trace?: LiveMdLeafAnalysisTrace,
): LeafAnalysisRecord {
  if (unit.type == "marker") {
    return createAnalysisRecord(
      unit,
      leafAnalysis(unit, unit.structuralEffects, [], renderKeyContext(input)),
      cacheId,
      input.state.doc.length,
    );
  }

  let descriptors = hasProblemNode(unit.leaf.node)
    ? []
    : relativeDescriptors(leafDescriptors(input, unit.leaf, trace), unit.sourceRange);
  return createAnalysisRecord(
    unit,
    leafAnalysis(unit, unit.structuralEffects, descriptors, renderKeyContext(input)),
    cacheId,
    input.state.doc.length,
  );
}

export function rekeyLeafAnalysis(
  unit: MarkdownLeafAnalysisUnit,
  analysis: LeafAnalysis,
  context: LiveMdRenderKeyContext | undefined,
): LeafAnalysis {
  return rekeyLeafAnalysisForSource(analysis, {
    context,
    kind: unit.kind,
    sourceHash: unit.cacheSourceHash,
    sourceLength: sourceLength(unit.cacheSourceRange),
  });
}

export function rekeyLeafAnalysisForSource(
  analysis: LeafAnalysis,
  input: {
    context?: LiveMdRenderKeyContext;
    kind: string;
    sourceHash: number;
    sourceLength: number;
  },
): LeafAnalysis {
  let renderKey = liveMdRenderKey(input);
  return renderKey == analysis.renderKey ? analysis : { ...analysis, renderKey };
}

export function liveMdRenderKey(input: {
  context?: LiveMdRenderKeyContext;
  kind: string;
  sourceHash: number;
  sourceLength: number;
}) {
  return stableRenderKey(input, input.context ?? defaultLiveMdRenderKeyContext);
}

export function sameLiveMdRenderKeyContext(
  left: LiveMdRenderKeyContext,
  right: LiveMdRenderKeyContext,
) {
  return (
    left.referenceEpoch == right.referenceEpoch &&
    left.rendererVersion == right.rendererVersion &&
    left.resolverEpoch == right.resolverEpoch &&
    left.themeEpoch == right.themeEpoch
  );
}

export function createAnalysisRecord(
  unit: MarkdownLeafAnalysisUnit,
  analysis: LeafAnalysis,
  cacheId: number,
  docLength?: number,
): LeafAnalysisRecord {
  return {
    analysis,
    cacheId,
    cacheSourceHash: unit.cacheSourceHash,
    cacheSourceRange: unit.cacheSourceRange,
    cacheStructuralKey: unit.cacheStructuralKey,
    context: unit.context,
    contextKey: unit.contextKey,
    effectRange: analysisEffectRange(analysis, unit.sourceRange, docLength),
    kind: unit.kind,
    range: unit.range,
    sourceHash: unit.sourceHash,
    sourceRange: unit.sourceRange,
    structuralKey: unit.structuralKey,
  };
}

function leafDescriptors(
  input: LiveMdLeafSemanticAnalysisInput,
  leaf: MarkdownLeaf,
  trace?: LiveMdLeafAnalysisTrace,
): LiveMdDescriptor[] {
  let inlineSession = inlineSessionFor(input);
  switch (leaf.kind) {
    case "paragraph":
      return leafInlineDescriptors(inlineSession, leaf);
    case "heading":
      return [...headingDescriptors(leaf.node), ...headingInlineDescriptors(inlineSession, leaf)];
    case "table": {
      let table = analyzeMarkdownTableAnalysis(input.state.doc, input.tree, leaf.range);
      if (trace) trace.tableCellsParsed += table.inlineRanges.length;
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

function inlineSessionFor(input: LiveMdLeafSemanticAnalysisInput): MarkdownInlineAnalysisSession {
  if (!input.inlineSession) throw new RangeError("Markdown inline analysis session is required");
  return input.inlineSession;
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
      range: marker.range,
    });
  }

  switch (marker.kind) {
    case "listMarker":
      descriptors.push({
        className: "cm-md-list-line",
        kind: "lineClass",
        range: marker.range,
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
        range: marker.range,
      });
      descriptors.push({
        className: "cm-md-task-line",
        kind: "lineClass",
        range: marker.range,
      });
      if (markerChecked(marker)) {
        descriptors.push({ className: "is-checked", kind: "lineClass", range: marker.range });
      }
      if (!sourceSafeOnly) {
        descriptors.push({
          checked: markerChecked(marker),
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

function markerCacheStructuralKey(marker: MarkdownMarkerRecord, sourceSafeOnly: boolean) {
  return JSON.stringify({
    checked: marker.kind == "taskMarker" ? markerChecked(marker) : null,
    kind: marker.kind,
    sourceSafeOnly,
  });
}

function markerChecked(marker: MarkdownMarkerRecord) {
  return marker.text.includes("x") || marker.text.includes("X");
}

function leafAnalysis(
  unit: MarkdownLeafAnalysisUnit,
  structuralEffects: readonly LiveMdDescriptor[],
  descriptors: readonly LiveMdDescriptor[],
  context: LiveMdRenderKeyContext,
): LeafAnalysis {
  return {
    analysisKey: stableAnalysisKey(unit.kind, unit.structuralKey, structuralEffects, descriptors),
    descriptors,
    renderKey: liveMdRenderKey({
      context,
      kind: unit.kind,
      sourceHash: unit.cacheSourceHash,
      sourceLength: sourceLength(unit.cacheSourceRange),
    }),
    structuralEffects,
  };
}

function renderKeyContext(input: LiveMdLeafSemanticAnalysisInput) {
  return input.renderKeyContext ?? defaultLiveMdRenderKeyContext;
}

function stableAnalysisKey(
  kind: string,
  structuralKey: string,
  structuralEffects: readonly LiveMdDescriptor[],
  descriptors: readonly LiveMdDescriptor[],
) {
  return hashString(
    JSON.stringify(["live-md-semantic-v1", kind, structuralKey, structuralEffects, descriptors]),
  );
}

function stableRenderKey(
  input: { kind: string; sourceHash: number; sourceLength: number },
  context: LiveMdRenderKeyContext,
) {
  return hashString(
    JSON.stringify([
      "live-md-render-key-v2",
      input.kind,
      input.sourceHash,
      input.sourceLength,
      context.rendererVersion,
      context.resolverEpoch,
      context.themeEpoch,
      context.referenceEpoch,
    ]),
  );
}

function sourceLength(range: DocRange) {
  return range.to - range.from;
}

function descriptorKey(descriptors: readonly LiveMdDescriptor[]) {
  return JSON.stringify(descriptors);
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

function compareUnits(left: MarkdownLeafAnalysisUnit, right: MarkdownLeafAnalysisUnit) {
  return (
    left.range.from - right.range.from ||
    left.range.to - right.range.to ||
    left.kind.localeCompare(right.kind)
  );
}

function nodeRange(node: SyntaxNode): DocRange {
  return { from: node.from, to: node.to };
}

function relativeDescriptors(
  descriptors: readonly LiveMdDescriptor[],
  sourceRange: DocRange,
): LiveMdDescriptor[] {
  return offsetLiveMdDescriptors(descriptors, -sourceRange.from);
}

function analysisEffectRange(
  analysis: LeafAnalysis,
  sourceRange: DocRange,
  docLength?: number,
): DocRange {
  let from = sourceRange.from;
  let to = sourceRange.to;
  for (let descriptor of [...analysis.structuralEffects, ...analysis.descriptors]) {
    for (let range of liveMdDescriptorRanges(descriptor)) {
      from = Math.min(from, range.from + sourceRange.from);
      to = Math.max(to, range.to + sourceRange.from);
    }
  }
  if (typeof docLength == "number") {
    from = clamp(from, 0, docLength);
    to = clamp(to, 0, docLength);
  }
  return { from, to };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function hashDocRange(doc: Text, range: DocRange): number {
  let hash = 0x811c9dc5;
  for (let iter = doc.iterRange(range.from, range.to); !iter.next().done; ) {
    if (iter.lineBreak) {
      hash = hashChar(hash, 10);
      continue;
    }
    let value = iter.value;
    for (let index = 0; index < value.length; index++) {
      hash = hashChar(hash, value.charCodeAt(index));
    }
  }
  return hash >>> 0;
}

function hashChar(hash: number, value: number) {
  hash ^= value;
  return Math.imul(hash, 0x01000193);
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
