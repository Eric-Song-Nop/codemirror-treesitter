import { Text } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import {
  type LeafAnalysisCache,
  type LeafAnalysisRecord,
  type LiveMdDescriptor,
  liveMdDescriptorKey,
  liveMdTableShapeKey,
  offsetLiveMdDescriptors,
} from "../analysis/descriptors.js";
import {
  forEachLeafAnalysisCacheRecord,
  forEachLeafAnalysisCacheRecordTouchingRanges,
} from "../analysis/markdown-leaf-cache.js";
import { rangesOverlap } from "../analysis/ranges.js";
import { type DocRange } from "../analysis/types.js";
import { liveMdLinkMark } from "../links.js";
import { type LiveMdFeatureDescriptor } from "../features.js";
import {
  cachedLiveMdImageSource,
  cachedLiveMdLatexResult,
  cachedLiveMdMermaidRequest,
  cachedLiveMdTableResult,
} from "../runtime/render-cache.js";
import { isWhitespaceOnly } from "../util.js";
import {
  ImagePreviewWidget,
  LatexWidget,
  ListMarkerWidget,
  MermaidWidget,
  TablePreviewWidget,
  TaskCheckboxWidget,
} from "../widgets.js";
import {
  addAtom,
  addLineClass,
  addLineRangeClass,
  addMark,
  addReplace,
  addSyntax,
  rangeTouchesActiveLine as buildRangeTouchesActiveLine,
  rangeTouchesActiveSource as buildRangeTouchesActiveSource,
} from "./emit.js";
import { addCodeFenceHighlights } from "./code-fence.js";
import {
  type LiveMdBuild,
  type LiveMdEffectSpec,
  type LiveMdMarkSpec,
  type LiveMdRenderStatus,
  type LiveMdWidgetSpec,
} from "./types.js";

const strongMark = Decoration.mark({ class: "cm-md-strong" });
const emphasisMark = Decoration.mark({ class: "cm-md-emphasis" });
const strikeMark = Decoration.mark({ class: "cm-md-strike" });
const inlineCodeMark = Decoration.mark({ class: "cm-md-inline-code" });
const tablePipeMark = Decoration.mark({ class: "cm-md-table-pipe" });

export type LiveMdEffectSpecMapper = (
  spec: LiveMdEffectSpec,
  record: LeafAnalysisRecord,
  build: LiveMdBuild,
) => readonly LiveMdEffectSpec[];

export type LiveMdProjectionLayerFilter = "all" | "direct" | "surface";

export function liveMdEffectSpecLayerMapper(
  layer: LiveMdProjectionLayerFilter,
): LiveMdEffectSpecMapper {
  if (layer == "all") return identityEffectSpec;
  return (spec, _record, build) => (liveMdEffectSpecLayer(build, spec) == layer ? [spec] : []);
}

export function liveMdRecordMayProduceDirectLayout(record: LeafAnalysisRecord) {
  return [...record.analysis.structuralEffects, ...record.analysis.descriptors].some(
    descriptorMayProduceDirectLayout,
  );
}

export function projectLeaf(
  record: LeafAnalysisRecord,
  active: boolean,
  renderStatus: LiveMdRenderStatus,
): readonly LiveMdEffectSpec[] {
  let specs: LiveMdEffectSpec[] = [];
  let seen = new Set<string>();
  let structuralEffects = offsetLiveMdDescriptors(
    record.analysis.structuralEffects,
    record.sourceRange.from,
  );
  let descriptors = offsetLiveMdDescriptors(record.analysis.descriptors, record.sourceRange.from);
  let inactiveTableRanges = inactiveTableReplacementRanges(descriptors, active, renderStatus);

  for (let descriptor of structuralEffects) {
    projectDescriptorOnce(specs, descriptor, active, renderStatus, inactiveTableRanges, seen);
  }
  for (let descriptor of descriptors) {
    projectDescriptorOnce(specs, descriptor, active, renderStatus, inactiveTableRanges, seen);
  }

  return specs;
}

export function projectLeafRecord(
  build: LiveMdBuild,
  record: LeafAnalysisRecord,
  seen = new Set<string>(),
  mapSpec: LiveMdEffectSpecMapper = identityEffectSpec,
) {
  let renderStatus = renderStatusForRecord(build, record);
  let active = buildRangeTouchesActiveLine(build, record.sourceRange.from, record.sourceRange.to);
  for (let spec of projectLeaf(record, active, renderStatus)) {
    for (let mapped of mapSpec(spec, record, build)) {
      materializeEffectSpecOnce(
        build,
        mapped,
        seen,
        liveMdEffectOwnerKeys(record, mapped),
        record.analysis.renderKey,
      );
    }
  }
}

export function projectLeafRecords(
  build: LiveMdBuild,
  records: readonly LeafAnalysisRecord[],
  mapSpec?: LiveMdEffectSpecMapper,
  shouldProjectRecord?: (record: LeafAnalysisRecord) => boolean,
) {
  let seen = new Set<string>();
  let projected = 0;
  for (let index = 0; index < records.length; index++) {
    if (index % 32 == 0) build.yieldCheck?.();
    let record = records[index]!;
    if (shouldProjectRecord && !shouldProjectRecord(record)) continue;
    projected++;
    projectLeafRecord(build, record, seen, mapSpec);
  }
  build.trace.projectionRecords += projected;
  return projected;
}

export function projectLeafCacheRecords(
  build: LiveMdBuild,
  cache: LeafAnalysisCache,
  mapSpec?: LiveMdEffectSpecMapper,
  shouldProjectRecord?: (record: LeafAnalysisRecord) => boolean,
) {
  let seen = new Set<string>();
  let projected = 0;
  forEachLeafAnalysisCacheRecord(cache, (record, index) => {
    if (index % 32 == 0) build.yieldCheck?.();
    if (shouldProjectRecord && !shouldProjectRecord(record)) return;
    projected++;
    projectLeafRecord(build, record, seen, mapSpec);
  });
  build.trace.projectionRecords += projected;
  return projected;
}

export function projectLeafCacheRecordsTouchingRanges(
  build: LiveMdBuild,
  cache: LeafAnalysisCache,
  ranges: readonly DocRange[],
  mapSpec?: LiveMdEffectSpecMapper,
  shouldProjectRecord?: (record: LeafAnalysisRecord) => boolean,
) {
  let seen = new Set<string>();
  let count = 0;
  forEachLeafAnalysisCacheRecordTouchingRanges(cache, ranges, (record, index) => {
    if (index % 32 == 0) build.yieldCheck?.();
    if (shouldProjectRecord && !shouldProjectRecord(record)) return;
    count++;
    projectLeafRecord(build, record, seen, mapSpec);
  });
  build.trace.projectionRecords += count;
  return count;
}

function identityEffectSpec(spec: LiveMdEffectSpec) {
  return [spec];
}

export function liveMdEffectSpecLayer(
  build: LiveMdBuild,
  spec: LiveMdEffectSpec,
): Exclude<LiveMdProjectionLayerFilter, "all"> {
  switch (spec.kind) {
    case "atomic":
    case "lineClass":
      return "direct";
    case "replace":
      return spec.block || crossesLineBreak(build, spec.from, spec.to) ? "direct" : "surface";
    case "codeFenceHighlight":
    case "mark":
    case "syntax":
      return "surface";
  }
}

function descriptorMayProduceDirectLayout(descriptor: LiveMdDescriptor) {
  switch (descriptor.kind) {
    case "codeFence":
    case "image":
    case "latex":
    case "lineClass":
    case "table":
      return true;
    case "feature":
      return featureDescriptorMayProduceDirectLayout(descriptor.effect);
    case "linkMark":
    case "listMarker":
    case "syntax":
    case "taskMarker":
    case "textMark":
      return false;
  }
}

function crossesLineBreak(build: LiveMdBuild, from: number, to: number) {
  if (from >= to) return false;
  let firstLine = build.state.doc.lineAt(from).number;
  let lastLine = build.state.doc.lineAt(Math.max(from, to - 1)).number;
  return firstLine != lastLine;
}

function projectDescriptorOnce(
  specs: LiveMdEffectSpec[],
  descriptor: LiveMdDescriptor,
  active: boolean,
  renderStatus: LiveMdRenderStatus,
  inactiveTableRanges: readonly DocRange[],
  seen: Set<string>,
) {
  if (isInactiveTableInlineDescriptor(descriptor, inactiveTableRanges)) return;

  let key = liveMdDescriptorKey(descriptor);
  if (seen.has(key)) return;
  seen.add(key);
  specs.push(...projectDescriptor(descriptor, active, renderStatus));
}

function projectDescriptor(
  descriptor: LiveMdDescriptor,
  active: boolean,
  renderStatus: LiveMdRenderStatus,
): readonly LiveMdEffectSpec[] {
  switch (descriptor.kind) {
    case "lineClass":
      return [
        {
          className: descriptor.className,
          from: descriptor.range.from,
          kind: "lineClass",
          to: descriptor.range.to,
        },
      ];
    case "syntax":
      return [syntaxSpec(descriptor.range.from, descriptor.range.to, descriptor.className)];
    case "textMark":
      return [
        {
          from: descriptor.range.from,
          kind: "mark",
          mark: { kind: "text", mark: descriptor.mark },
          to: descriptor.range.to,
        },
      ];
    case "linkMark":
      return [
        {
          from: descriptor.range.from,
          kind: "mark",
          mark: { destination: descriptor.destination, kind: "link" },
          to: descriptor.range.to,
        },
      ];
    case "listMarker":
      return projectListMarker(descriptor, active, renderStatus);
    case "taskMarker":
      return projectTaskMarker(descriptor, active, renderStatus);
    case "image":
      return projectImage(descriptor, active, renderStatus);
    case "latex":
      return projectLatex(descriptor, active, renderStatus);
    case "table":
      return projectTable(descriptor, active, renderStatus);
    case "codeFence":
      return projectCodeFence(descriptor, active, renderStatus);
    case "feature":
      return projectFeature(descriptor.effect, active, renderStatus);
  }
}

function projectFeature(
  descriptor: LiveMdFeatureDescriptor,
  active: boolean,
  renderStatus: LiveMdRenderStatus,
): readonly LiveMdEffectSpec[] {
  switch (descriptor.kind) {
    case "lineClass":
      return [
        {
          className: descriptor.className,
          from: descriptor.range.from,
          kind: "lineClass",
          to: descriptor.range.to,
        },
      ];
    case "mark":
      return [
        {
          from: descriptor.range.from,
          kind: "mark",
          mark: { className: descriptor.className, kind: "class" },
          to: descriptor.range.to,
        },
      ];
    case "syntax":
      return [syntaxSpec(descriptor.range.from, descriptor.range.to, descriptor.className)];
    case "replace":
      if (isEditableSource(active, renderStatus)) return [];
      return [
        {
          atomic: descriptor.atomic,
          block: descriptor.block,
          from: descriptor.range.from,
          kind: "replace",
          to: descriptor.range.to,
          widget: { kind: "feature", spec: descriptor.widget },
        },
      ];
  }
}

function syntaxSpec(from: number, to: number, className?: string): LiveMdEffectSpec {
  return className ? { className, from, kind: "syntax", to } : { from, kind: "syntax", to };
}

function projectListMarker(
  descriptor: Extract<LiveMdDescriptor, { kind: "listMarker" }>,
  active: boolean,
  renderStatus: LiveMdRenderStatus,
): readonly LiveMdEffectSpec[] {
  if (isEditableSource(active, renderStatus)) {
    return [syntaxSpec(descriptor.range.from, descriptor.range.to)];
  }
  return [
    {
      from: descriptor.range.from,
      kind: "replace",
      to: descriptor.range.to,
      widget: { kind: "listMarker", marker: descriptor.marker },
    },
  ];
}

function projectTaskMarker(
  descriptor: Extract<LiveMdDescriptor, { kind: "taskMarker" }>,
  active: boolean,
  renderStatus: LiveMdRenderStatus,
): readonly LiveMdEffectSpec[] {
  if (isEditableSource(active, renderStatus)) {
    return [syntaxSpec(descriptor.range.from, descriptor.range.to)];
  }
  return [
    {
      from: descriptor.range.from,
      kind: "replace",
      to: descriptor.range.to,
      widget: { checked: descriptor.checked, kind: "taskMarker" },
    },
  ];
}

function projectImage(
  descriptor: Extract<LiveMdDescriptor, { kind: "image" }>,
  active: boolean,
  renderStatus: LiveMdRenderStatus,
): readonly LiveMdEffectSpec[] {
  let editable = isEditableSource(active, renderStatus);
  let widget: LiveMdWidgetSpec = {
    alt: descriptor.alt,
    kind: "imagePreview",
    source: descriptor.source,
  };

  if (
    !editable &&
    isOnlyVisibleContentOnLine(
      renderStatus,
      descriptor.lineRange.from,
      descriptor.lineRange.to,
      descriptor.range.from,
      descriptor.range.to,
    )
  ) {
    return [
      {
        block: true,
        from: descriptor.lineRange.from,
        kind: "replace",
        to: descriptor.lineRange.to,
        widget,
      },
    ];
  }

  if (!editable) {
    return [
      {
        from: descriptor.range.from,
        kind: "replace",
        to: descriptor.range.to,
        widget,
      },
    ];
  }

  if (!descriptor.descriptionRange) return [];

  return [
    syntaxSpec(descriptor.range.from, descriptor.descriptionRange.from),
    {
      from: descriptor.descriptionRange.from,
      kind: "mark",
      mark: { destination: null, kind: "link" },
      to: descriptor.descriptionRange.to,
    },
    syntaxSpec(descriptor.descriptionRange.to, descriptor.range.to),
  ];
}

function projectLatex(
  descriptor: Extract<LiveMdDescriptor, { kind: "latex" }>,
  active: boolean,
  renderStatus: LiveMdRenderStatus,
): readonly LiveMdEffectSpec[] {
  if (isEditableSource(active, renderStatus)) return [];

  let replacement = descriptor.formula.replacementRange;
  return [
    {
      block: replacement.block,
      from: replacement.from,
      kind: "replace",
      to: replacement.to,
      widget: {
        block: replacement.block,
        displayMode: descriptor.formula.displayMode,
        kind: "latex",
        source: descriptor.formula.source,
        tex: descriptor.formula.tex,
      },
    },
  ];
}

function projectTable(
  descriptor: Extract<LiveMdDescriptor, { kind: "table" }>,
  active: boolean,
  renderStatus: LiveMdRenderStatus,
): readonly LiveMdEffectSpec[] {
  if (descriptor.table && !tableTouchesActiveLine(renderStatus, descriptor, active)) {
    return [
      {
        block: true,
        from: descriptor.range.from,
        kind: "replace",
        to: descriptor.range.to,
        widget: { kind: "tablePreview", table: descriptor.table },
      },
    ];
  }

  let specs: LiveMdEffectSpec[] = [
    {
      className: "cm-md-table-line",
      from: descriptor.range.from,
      kind: "lineClass",
      to: descriptor.range.to,
    },
  ];

  if (descriptor.delimiterRowRange) {
    specs.push({
      className: "cm-md-table-divider",
      from: descriptor.delimiterRowRange.from,
      kind: "lineClass",
      to: descriptor.delimiterRowRange.to,
    });
  }

  for (let pipe of descriptor.pipeRanges) {
    specs.push(syntaxSpec(pipe.from, pipe.to, "cm-md-table-pipe"));
  }

  return specs;
}

function projectCodeFence(
  descriptor: Extract<LiveMdDescriptor, { kind: "codeFence" }>,
  active: boolean,
  renderStatus: LiveMdRenderStatus,
): readonly LiveMdEffectSpec[] {
  if (descriptor.mermaidSource && !isEditableSource(active, renderStatus)) {
    return [
      {
        block: true,
        from: descriptor.range.from,
        kind: "replace",
        to: descriptor.range.to,
        widget: { kind: "mermaid", source: descriptor.mermaidSource },
      },
    ];
  }

  let specs: LiveMdEffectSpec[] = [];
  let openingLineNumber = renderStatus.doc.lineAt(descriptor.openingDelimiterRange.from).number;
  let blockEndLineNumber = openingLineNumber;
  specs.push(
    {
      className: "cm-md-code-fence-line",
      from: descriptor.openingDelimiterRange.from,
      kind: "lineClass",
      to: descriptor.openingDelimiterRange.to,
    },
    {
      className: "cm-md-code-block-start",
      from: descriptor.openingDelimiterRange.from,
      kind: "lineClass",
      to: descriptor.openingDelimiterRange.to,
    },
    syntaxSpec(descriptor.openingDelimiterRange.from, descriptor.openingDelimiterRange.to),
  );

  if (descriptor.contentRange && descriptor.contentRange.from < descriptor.contentRange.to) {
    forEachLineInRange(
      renderStatus.doc,
      descriptor.contentRange.from,
      descriptor.contentRange.to,
      (line) => {
        specs.push({
          className: "cm-md-code-line",
          from: line.from,
          kind: "lineClass",
          to: line.to,
        });
        blockEndLineNumber = line.number;
      },
    );
    specs.push({
      contentFrom: descriptor.contentRange.from,
      contentTo: descriptor.contentRange.to,
      kind: "codeFenceHighlight",
      language: descriptor.language,
    });
  }

  if (descriptor.closingDelimiterRange) {
    blockEndLineNumber = renderStatus.doc.lineAt(descriptor.closingDelimiterRange.from).number;
    specs.push(
      {
        className: "cm-md-code-fence-line",
        from: descriptor.closingDelimiterRange.from,
        kind: "lineClass",
        to: descriptor.closingDelimiterRange.to,
      },
      syntaxSpec(descriptor.closingDelimiterRange.from, descriptor.closingDelimiterRange.to),
    );
  }

  let blockEndLine = renderStatus.doc.line(blockEndLineNumber);
  specs.push({
    className: "cm-md-code-block-end",
    from: blockEndLine.from,
    kind: "lineClass",
    to: blockEndLine.to,
  });
  return specs;
}

function inactiveTableReplacementRanges(
  descriptors: readonly LiveMdDescriptor[],
  active: boolean,
  renderStatus: LiveMdRenderStatus,
): readonly DocRange[] {
  if (isEditableSource(active, renderStatus)) return [];

  let ranges: DocRange[] = [];
  for (let descriptor of descriptors) {
    if (
      descriptor.kind == "table" &&
      descriptor.table &&
      !tableTouchesActiveLine(renderStatus, descriptor, active)
    ) {
      ranges.push(descriptor.range);
    }
  }
  return ranges;
}

function isInactiveTableInlineDescriptor(
  descriptor: LiveMdDescriptor,
  tableRanges: readonly DocRange[],
) {
  if (!tableRanges.length || !isInlineDescriptor(descriptor)) return false;
  return tableRanges.some((range) => containsRange(range, descriptor.range));
}

function isInlineDescriptor(
  descriptor: LiveMdDescriptor,
): descriptor is Extract<
  LiveMdDescriptor,
  { kind: "image" | "latex" | "linkMark" | "syntax" | "textMark" }
> {
  switch (descriptor.kind) {
    case "image":
    case "latex":
    case "linkMark":
    case "syntax":
    case "textMark":
      return true;
    default:
      return false;
  }
}

function tableTouchesActiveLine(
  renderStatus: LiveMdRenderStatus,
  descriptor: Extract<LiveMdDescriptor, { kind: "table" }>,
  active: boolean,
) {
  if (
    active ||
    rangeTouchesActiveSource(renderStatus, descriptor.range.from, descriptor.range.to)
  ) {
    return true;
  }
  if (renderStatus.sourceIslandMode) return false;
  if (rangeTouchesActiveLine(renderStatus, descriptor.range.from, descriptor.range.to)) return true;
  if (descriptor.table?.rows.length) return false;

  let end = Math.min(descriptor.range.to, renderStatus.doc.length);
  let lastLine = renderStatus.doc.lineAt(Math.max(descriptor.range.from, end - 1));
  let nextLineNumber = lastLine.number + 1;
  if (!renderStatus.activeLines.has(nextLineNumber) || nextLineNumber > renderStatus.doc.lines) {
    return false;
  }
  let nextLine = renderStatus.doc.line(nextLineNumber);
  return isWhitespaceOnly(renderStatus.doc.sliceString(nextLine.from, nextLine.to));
}

function isEditableSource(active: boolean, renderStatus: LiveMdRenderStatus) {
  return active || renderStatus.activeSource;
}

function rangeTouchesActiveLine(renderStatus: LiveMdRenderStatus, from: number, to: number) {
  if (rangeTouchesActiveSource(renderStatus, from, to)) return true;
  if (renderStatus.sourceIslandMode) return false;
  let firstLine = renderStatus.doc.lineAt(from).number;
  let lastLine = renderStatus.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber of renderStatus.activeLines) {
    if (lineNumber >= firstLine && lineNumber <= lastLine) return true;
  }
  return false;
}

function rangeTouchesActiveSource(renderStatus: LiveMdRenderStatus, from: number, to: number) {
  return (
    renderStatus.activeSource ||
    renderStatus.activeSourceRanges.some((range) => rangesOverlap(range, { from, to }))
  );
}

function containsRange(outer: DocRange, inner: DocRange) {
  return outer.from <= inner.from && inner.to <= outer.to;
}

function isOnlyVisibleContentOnLine(
  renderStatus: LiveMdRenderStatus,
  lineFrom: number,
  lineTo: number,
  contentFrom: number,
  contentTo: number,
) {
  return (
    isWhitespaceOnly(renderStatus.doc.sliceString(lineFrom, contentFrom)) &&
    isWhitespaceOnly(renderStatus.doc.sliceString(contentTo, lineTo))
  );
}

function forEachLineInRange(
  doc: Text,
  from: number,
  to: number,
  visit: (line: { from: number; number: number; to: number }) => void,
) {
  if (from >= to) return;
  let firstLine = doc.lineAt(from).number;
  let lastLine = doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
    visit(doc.line(lineNumber));
  }
}

function renderStatusForRecord(build: LiveMdBuild, record: LeafAnalysisRecord): LiveMdRenderStatus {
  return {
    activeLines: build.activeLines,
    activeSource: buildRangeTouchesActiveSource(
      build,
      record.sourceRange.from,
      record.sourceRange.to,
    ),
    activeSourceRanges: build.activeSourceRanges,
    doc: build.state.doc,
    sourceIslandMode: build.sourceIslandMode,
  };
}

function materializeEffectSpecOnce(
  build: LiveMdBuild,
  spec: LiveMdEffectSpec,
  seen: Set<string>,
  ownerKeys: readonly string[] = [],
  recordRenderKey = "",
) {
  let key = liveMdEffectSpecKey(spec);
  if (seen.has(key)) return;
  seen.add(key);
  materializeEffectSpec(build, spec, ownerKeys, recordRenderKey);
}

export function liveMdRecordOwnerKey(cacheId: number) {
  return `record:${cacheId}`;
}

export function liveMdEffectOwnerKeys(
  record: LeafAnalysisRecord,
  spec: LiveMdEffectSpec,
): readonly string[] {
  let recordKey = liveMdRecordOwnerKey(record.cacheId);
  return [
    recordKey,
    `${recordKey}:effect:${liveMdRelativeEffectSpecKey(spec, record.sourceRange.from)}`,
  ];
}

function liveMdEffectSpecKey(spec: LiveMdEffectSpec) {
  switch (spec.kind) {
    case "atomic":
      return keyParts("atomic", rangeKey(spec));
    case "codeFenceHighlight":
      return keyParts(
        "codeFenceHighlight",
        spec.contentFrom,
        spec.contentTo,
        spec.emitFrom ?? spec.contentFrom,
        spec.emitTo ?? spec.contentTo,
        spec.language,
      );
    case "lineClass":
      return keyParts("lineClass", rangeKey(spec), spec.className);
    case "mark":
      return keyParts("mark", rangeKey(spec), markSpecKey(spec.mark));
    case "replace":
      return keyParts(
        "replace",
        rangeKey(spec),
        spec.block ? 1 : 0,
        spec.atomic ? 1 : 0,
        widgetSpecKey(spec.widget),
      );
    case "syntax":
      return keyParts("syntax", rangeKey(spec), spec.className);
  }
}

function liveMdRelativeEffectSpecKey(spec: LiveMdEffectSpec, offset: number) {
  switch (spec.kind) {
    case "atomic":
      return keyParts("atomic", relativeRangeKey(spec, offset));
    case "codeFenceHighlight":
      return keyParts(
        "codeFenceHighlight",
        spec.contentFrom - offset,
        spec.contentTo - offset,
        (spec.emitFrom ?? spec.contentFrom) - offset,
        (spec.emitTo ?? spec.contentTo) - offset,
        spec.language,
      );
    case "lineClass":
      return keyParts("lineClass", relativeRangeKey(spec, offset), spec.className);
    case "mark":
      return keyParts("mark", relativeRangeKey(spec, offset), markSpecKey(spec.mark));
    case "replace":
      return keyParts(
        "replace",
        relativeRangeKey(spec, offset),
        spec.block ? 1 : 0,
        spec.atomic ? 1 : 0,
        widgetSpecKey(spec.widget),
      );
    case "syntax":
      return keyParts("syntax", relativeRangeKey(spec, offset), spec.className);
  }
}

function markSpecKey(mark: LiveMdMarkSpec) {
  switch (mark.kind) {
    case "class":
      return keyParts("class", mark.className);
    case "link":
      return keyParts("link", mark.destination);
    case "text":
      return keyParts("text", mark.mark);
  }
}

function widgetSpecKey(widget: LiveMdWidgetSpec) {
  switch (widget.kind) {
    case "imagePreview":
      return keyParts("imagePreview", widget.source, widget.alt);
    case "latex":
      return keyParts(
        "latex",
        widget.block ? 1 : 0,
        widget.displayMode ? 1 : 0,
        widget.source,
        widget.tex,
      );
    case "listMarker":
      return keyParts("listMarker", widget.marker);
    case "mermaid":
      return keyParts("mermaid", widget.source);
    case "tablePreview":
      return keyParts("tablePreview", liveMdTableShapeKey(widget.table));
    case "taskMarker":
      return keyParts("taskMarker", widget.checked ? 1 : 0);
    case "feature":
      return keyParts("feature", widget.spec.key);
  }
}

function featureDescriptorMayProduceDirectLayout(descriptor: LiveMdFeatureDescriptor) {
  switch (descriptor.kind) {
    case "lineClass":
    case "replace":
      return true;
    case "mark":
    case "syntax":
      return false;
  }
}

function rangeKey(range: DocRange) {
  return `${range.from}-${range.to}`;
}

function relativeRangeKey(range: DocRange, offset: number) {
  return `${range.from - offset}-${range.to - offset}`;
}

function keyParts(...parts: readonly (boolean | number | string | null | undefined)[]) {
  return parts
    .map((part) => {
      let text = part == null ? "" : String(part);
      return `${text.length}:${text}`;
    })
    .join("|");
}

function materializeEffectSpec(
  build: LiveMdBuild,
  spec: LiveMdEffectSpec,
  ownerKeys: readonly string[] = [],
  recordRenderKey = "",
) {
  switch (spec.kind) {
    case "atomic":
      addAtom(build, spec.from, spec.to, ownerKeys);
      break;
    case "codeFenceHighlight":
      addCodeFenceHighlights(
        build,
        spec.contentFrom,
        spec.contentTo,
        spec.emitFrom ?? spec.contentFrom,
        spec.emitTo ?? spec.contentTo,
        spec.language,
        recordRenderKey,
      );
      break;
    case "lineClass": {
      if (spec.from == spec.to) {
        addLineClass(build, build.state.doc.lineAt(spec.from).number, spec.className, ownerKeys);
      } else {
        addLineRangeClass(build, spec.from, spec.to, spec.className, ownerKeys);
      }
      break;
    }
    case "mark":
      addMark(build, spec.from, spec.to, markDecoration(build, spec.mark), ownerKeys);
      break;
    case "replace":
      addReplace(
        build,
        spec.from,
        spec.to,
        widgetFromSpec(build, spec.widget, recordRenderKey, spec.block ?? false),
        spec.block ?? false,
        spec.atomic ?? false,
        ownerKeys,
      );
      break;
    case "syntax":
      addSyntax(
        build,
        spec.from,
        spec.to,
        spec.className ? Decoration.mark({ class: spec.className }) : undefined,
        ownerKeys,
      );
      break;
  }
}

function markDecoration(build: LiveMdBuild, mark: LiveMdMarkSpec) {
  switch (mark.kind) {
    case "class":
      return Decoration.mark({ class: mark.className });
    case "link":
      return liveMdLinkMark(mark.destination, build.linkBaseUrl);
    case "text":
      return textMark(mark.mark);
  }
}

function textMark(mark: Extract<LiveMdDescriptor, { kind: "textMark" }>["mark"]) {
  switch (mark) {
    case "emphasis":
      return emphasisMark;
    case "inlineCode":
      return inlineCodeMark;
    case "strike":
      return strikeMark;
    case "strong":
      return strongMark;
    case "tablePipe":
      return tablePipeMark;
  }
}

function widgetFromSpec(
  build: LiveMdBuild,
  spec: LiveMdWidgetSpec,
  recordRenderKey: string,
  block: boolean,
) {
  build.trace.widgetConstructions++;
  switch (spec.kind) {
    case "imagePreview": {
      let image = cachedLiveMdImageSource(
        build.renderCache,
        build.trace,
        recordRenderKey,
        spec.source,
        build.imageSourceResolver,
      );
      return new ImagePreviewWidget(spec.alt, image, build.renderCache.measuredHeights, block);
    }
    case "latex":
      return new LatexWidget(
        {
          block: spec.block,
          displayMode: spec.displayMode,
          source: spec.source,
          tex: spec.tex,
        },
        cachedLiveMdLatexResult(build.renderCache, build.trace, recordRenderKey, {
          block: spec.block,
          displayMode: spec.displayMode,
          source: spec.source,
          tex: spec.tex,
        }),
        build.renderCache.measuredHeights,
      );
    case "listMarker":
      return new ListMarkerWidget(spec.marker);
    case "mermaid":
      return new MermaidWidget(
        cachedLiveMdMermaidRequest(build.renderCache, build.trace, recordRenderKey, spec.source),
        build.renderCache.measuredHeights,
      );
    case "tablePreview": {
      let result = cachedLiveMdTableResult(
        build.renderCache,
        build.trace,
        recordRenderKey,
        spec.table,
      );
      return new TablePreviewWidget(
        result.table,
        build.renderCache.measuredHeights,
        result.resultKey,
        build.linkBaseUrl,
        build.imageSourceResolver,
      );
    }
    case "taskMarker":
      return new TaskCheckboxWidget(spec.checked);
    case "feature":
      return spec.spec.widget;
  }
}
