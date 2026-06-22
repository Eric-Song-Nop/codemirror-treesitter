import { Text } from "@codemirror/state";
import { highlightTree, type Tree, type TreeSitterParser } from "@codemirror-treesitter/language";
import { Decoration } from "@codemirror/view";
import {
  type LeafAnalysisRecord,
  type LiveMdDescriptor,
  type LiveMdTableModel,
  offsetLiveMdDescriptors,
} from "../analysis/descriptors.js";
import { type DocRange } from "../analysis/types.js";
import { resolveLiveMdImageSource } from "../images.js";
import { deleteLiveMdTree } from "../languages.js";
import { liveMdLinkMark } from "../links.js";
import { isWhitespaceOnly } from "../util.js";
import {
  ImagePreviewWidget,
  LatexWidget,
  ListMarkerWidget,
  type MarkdownTable,
  MermaidWidget,
  TablePreviewWidget,
  TaskCheckboxWidget,
} from "../widgets.js";
import {
  addAtom,
  addLineRangeClass,
  addMark,
  addReplace,
  addSyntax,
  rangeTouchesActiveLine as buildRangeTouchesActiveLine,
  rangeTouchesActiveSource as buildRangeTouchesActiveSource,
} from "./emit.js";
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
) {
  let renderStatus = renderStatusForRecord(build, record);
  let active = buildRangeTouchesActiveLine(build, record.sourceRange.from, record.sourceRange.to);
  for (let spec of projectLeaf(record, active, renderStatus)) {
    materializeEffectSpecOnce(build, spec, seen);
  }
}

export function projectLeafRecords(build: LiveMdBuild, records: readonly LeafAnalysisRecord[]) {
  let seen = new Set<string>();
  build.trace.projectionRecords += records.length;
  for (let index = 0; index < records.length; index++) {
    if (index % 32 == 0) build.yieldCheck?.();
    projectLeafRecord(build, records[index]!, seen);
  }
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

  let key = JSON.stringify(descriptor);
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
    renderStatus.activeSourceRanges.some((range) => rangesOverlap(range, from, to))
  );
}

function rangesOverlap(range: DocRange, from: number, to: number) {
  return range.from < to && from < range.to;
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

function materializeEffectSpecOnce(build: LiveMdBuild, spec: LiveMdEffectSpec, seen: Set<string>) {
  let key = JSON.stringify(spec);
  if (seen.has(key)) return;
  seen.add(key);
  materializeEffectSpec(build, spec);
}

function materializeEffectSpec(build: LiveMdBuild, spec: LiveMdEffectSpec) {
  switch (spec.kind) {
    case "atomic":
      addAtom(build, spec.from, spec.to);
      break;
    case "codeFenceHighlight":
      addCodeFenceHighlights(build, spec.contentFrom, spec.contentTo, spec.language);
      break;
    case "lineClass":
      addLineRangeClass(build, spec.from, spec.to, spec.className);
      break;
    case "mark":
      addMark(build, spec.from, spec.to, markDecoration(build, spec.mark));
      break;
    case "replace":
      addReplace(
        build,
        spec.from,
        spec.to,
        widgetFromSpec(build, spec.widget),
        spec.block ?? false,
        spec.atomic ?? false,
      );
      break;
    case "syntax":
      addSyntax(
        build,
        spec.from,
        spec.to,
        spec.className ? Decoration.mark({ class: spec.className }) : undefined,
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

function widgetFromSpec(build: LiveMdBuild, spec: LiveMdWidgetSpec) {
  switch (spec.kind) {
    case "imagePreview":
      return new ImagePreviewWidget(
        spec.alt,
        resolveLiveMdImageSource(spec.source, build.imageSourceResolver),
      );
    case "latex":
      return new LatexWidget({
        block: spec.block,
        displayMode: spec.displayMode,
        source: spec.source,
        tex: spec.tex,
      });
    case "listMarker":
      return new ListMarkerWidget(spec.marker);
    case "mermaid":
      return new MermaidWidget({ source: spec.source });
    case "tablePreview":
      return new TablePreviewWidget(markdownTable(spec.table));
    case "taskMarker":
      return new TaskCheckboxWidget(spec.checked);
  }
}

function markdownTable(table: LiveMdTableModel): MarkdownTable {
  return {
    alignments: [...table.alignments],
    header: [...table.header],
    rows: table.rows.map((row) => [...row]),
  };
}

function addCodeFenceHighlights(
  build: LiveMdBuild,
  contentFrom: number,
  contentTo: number,
  language: string,
) {
  let parser = build.codeFenceLanguages.get(language);
  if (!parser || contentFrom >= contentTo) return;

  let sourceText = Text.of(build.state.sliceDoc(contentFrom, contentTo).split("\n"));
  let nativeParser = parser.createParser();
  let nestedParsers = new Map<TreeSitterParser, ReturnType<TreeSitterParser["createParser"]>>();
  let parsed: ReturnType<typeof parser.parseWith> | null = null;
  let tree: Tree | null = null;
  build.trace.codeFenceParserSessionsCreated++;
  try {
    build.trace.codeFenceParses++;
    parsed = parser.parseWith(nativeParser, sourceText);
    if (!parsed) return;
    tree = parser.wrapTree(parsed, sourceText, null, undefined, nestedParsers);
    if (!tree) return;
    highlightTree(
      tree,
      build.codeFenceHighlighters,
      (from, to, className) => {
        let decoration = Decoration.mark({ class: className });
        splitTextRangeByLine(sourceText, from, to, (rangeFrom, rangeTo) => {
          addMark(build, contentFrom + rangeFrom, contentFrom + rangeTo, decoration);
        });
      },
      0,
      sourceText.length,
    );
  } finally {
    build.trace.codeFenceParserSessionsCreated += nestedParsers.size;
    let treeCount = tree ? countNativeTrees(tree) : parsed ? 1 : 0;
    build.trace.codeFenceTreesCreated += treeCount;
    if (tree) deleteLiveMdTree(tree);
    else parsed?.delete();
    build.trace.codeFenceTreesDeleted += treeCount;

    for (let nestedParser of nestedParsers.values()) {
      build.trace.codeFenceParserSessionsDeleted++;
      nestedParser.delete();
    }
    build.trace.codeFenceParserSessionsDeleted++;
    nativeParser.delete();
  }
}

function countNativeTrees(tree: Tree): number {
  let count = tree.tree ? 1 : 0;
  for (let nested of tree.nested) {
    count += countNativeTrees(nested.tree);
  }
  return count;
}

function splitTextRangeByLine(
  text: Text,
  from: number,
  to: number,
  visit: (from: number, to: number) => void,
) {
  let cursor = from;
  while (cursor < to) {
    let line = text.lineAt(cursor);
    let rangeTo = Math.min(to, line.to);
    if (cursor < rangeTo) visit(cursor, rangeTo);
    cursor = line.to < to ? line.to + 1 : to;
  }
}
