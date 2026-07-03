import { type RangeSet, type RangeValue } from "@codemirror/state";
import { type MarkdownBlockContext, type MarkdownLeafKind } from "./markdown-block-types.js";
import { type DocRange } from "./types.js";
import { type LiveMdFeatureDescriptor } from "../features.js";

export type LiveMdTextMarkKind = "emphasis" | "inlineCode" | "strike" | "strong" | "tablePipe";

export type LiveMdTableAlignment = "center" | "default" | "left" | "right";

export type LiveMdTableModel = {
  alignments: readonly LiveMdTableAlignment[];
  header: readonly string[];
  rows: readonly (readonly string[])[];
};

export type LiveMdLatexFormulaDescriptor = {
  displayMode: boolean;
  replacementRange: DocRange & { block: boolean };
  source: string;
  tex: string;
};

export type LiveMdDescriptor =
  | {
      className: string;
      kind: "lineClass";
      range: DocRange;
    }
  | {
      className?: string;
      kind: "syntax";
      range: DocRange;
    }
  | {
      kind: "textMark";
      mark: LiveMdTextMarkKind;
      range: DocRange;
    }
  | {
      destination: string | null;
      kind: "linkMark";
      range: DocRange;
      sourceRange: DocRange;
    }
  | {
      kind: "listMarker";
      marker: string;
      range: DocRange;
    }
  | {
      checked: boolean;
      kind: "taskMarker";
      range: DocRange;
    }
  | {
      alt: string;
      descriptionRange: DocRange | null;
      destinationRange: DocRange | null;
      kind: "image";
      lineRange: DocRange;
      range: DocRange;
      source: string;
    }
  | {
      formula: LiveMdLatexFormulaDescriptor;
      kind: "latex";
      range: DocRange;
    }
  | {
      delimiterRowRange: DocRange | null;
      kind: "table";
      pipeRanges: readonly DocRange[];
      range: DocRange;
      table: LiveMdTableModel | null;
    }
  | {
      closingDelimiterRange: DocRange | null;
      contentRange: DocRange | null;
      kind: "codeFence";
      language: string;
      mermaidSource: string | null;
      openingDelimiterRange: DocRange;
      range: DocRange;
    }
  | {
      effect: LiveMdFeatureDescriptor;
      feature: string;
      kind: "feature";
    };

export type LeafAnalysis = {
  analysisKey: string;
  descriptors: readonly LiveMdDescriptor[];
  renderKey: string;
  structuralEffects: readonly LiveMdDescriptor[];
};

export type LeafAnalysisRecord = {
  analysis: LeafAnalysis;
  cacheId: number;
  cacheSourceHash?: number;
  cacheSourceRange?: DocRange;
  cacheStructuralKey?: string;
  context: MarkdownBlockContext;
  contextKey: string;
  effectRange: DocRange;
  kind: MarkdownLeafKind | "marker";
  range: DocRange;
  /**
   * Range whose destructive projection must be revealed while an edit to this
   * record is pending, or null when the record projects nothing destructive
   * (line classes and text marks are source-safe). Leaf records scan only
   * their own leaf-local descriptors; marker records scan structuralEffects,
   * which hold the marker's own listMarker/taskMarker descriptors. Invariant:
   * revealRange, when non-null, is contained in effectRange.
   */
  revealRange: DocRange | null;
  sourceHash: number;
  sourceRange: DocRange;
  structuralKey: string;
};

export type LeafAnalysisCache = {
  records: RangeSet<RangeValue>;
  safety: RangeSet<RangeValue>;
  recordCount: number;
  nextCacheId: number;
};

export type LiveMdSemanticState = {
  cache: LeafAnalysisCache;
  revision: number;
};

export function offsetLiveMdDescriptor(
  descriptor: LiveMdDescriptor,
  offset: number,
): LiveMdDescriptor {
  switch (descriptor.kind) {
    case "lineClass":
      return { ...descriptor, range: offsetRange(descriptor.range, offset) };
    case "syntax":
      return { ...descriptor, range: offsetRange(descriptor.range, offset) };
    case "textMark":
      return { ...descriptor, range: offsetRange(descriptor.range, offset) };
    case "linkMark":
      return {
        ...descriptor,
        range: offsetRange(descriptor.range, offset),
        sourceRange: offsetRange(descriptor.sourceRange, offset),
      };
    case "listMarker":
      return { ...descriptor, range: offsetRange(descriptor.range, offset) };
    case "taskMarker":
      return { ...descriptor, range: offsetRange(descriptor.range, offset) };
    case "image":
      return {
        ...descriptor,
        descriptionRange: descriptor.descriptionRange
          ? offsetRange(descriptor.descriptionRange, offset)
          : null,
        destinationRange: descriptor.destinationRange
          ? offsetRange(descriptor.destinationRange, offset)
          : null,
        lineRange: offsetRange(descriptor.lineRange, offset),
        range: offsetRange(descriptor.range, offset),
      };
    case "latex":
      return {
        ...descriptor,
        formula: {
          ...descriptor.formula,
          replacementRange: {
            ...offsetRange(descriptor.formula.replacementRange, offset),
            block: descriptor.formula.replacementRange.block,
          },
        },
        range: offsetRange(descriptor.range, offset),
      };
    case "table":
      return {
        ...descriptor,
        delimiterRowRange: descriptor.delimiterRowRange
          ? offsetRange(descriptor.delimiterRowRange, offset)
          : null,
        pipeRanges: descriptor.pipeRanges.map((range) => offsetRange(range, offset)),
        range: offsetRange(descriptor.range, offset),
      };
    case "codeFence":
      return {
        ...descriptor,
        closingDelimiterRange: descriptor.closingDelimiterRange
          ? offsetRange(descriptor.closingDelimiterRange, offset)
          : null,
        contentRange: descriptor.contentRange ? offsetRange(descriptor.contentRange, offset) : null,
        openingDelimiterRange: offsetRange(descriptor.openingDelimiterRange, offset),
        range: offsetRange(descriptor.range, offset),
      };
    case "feature":
      return {
        ...descriptor,
        effect: offsetLiveMdFeatureDescriptor(descriptor.effect, offset),
      };
  }
}

export function offsetLiveMdDescriptors(
  descriptors: readonly LiveMdDescriptor[],
  offset: number,
): LiveMdDescriptor[] {
  return descriptors.map((descriptor) => offsetLiveMdDescriptor(descriptor, offset));
}

export function liveMdDescriptorRanges(descriptor: LiveMdDescriptor): DocRange[] {
  switch (descriptor.kind) {
    case "lineClass":
    case "syntax":
    case "textMark":
    case "listMarker":
    case "taskMarker":
      return [descriptor.range];
    case "linkMark":
      return [descriptor.range, descriptor.sourceRange];
    case "image":
      return [
        descriptor.range,
        descriptor.lineRange,
        ...(descriptor.descriptionRange ? [descriptor.descriptionRange] : []),
        ...(descriptor.destinationRange ? [descriptor.destinationRange] : []),
      ];
    case "latex":
      return [descriptor.range, descriptor.formula.replacementRange];
    case "table":
      return [
        descriptor.range,
        ...descriptor.pipeRanges,
        ...(descriptor.delimiterRowRange ? [descriptor.delimiterRowRange] : []),
      ];
    case "codeFence":
      return [
        descriptor.range,
        descriptor.openingDelimiterRange,
        ...(descriptor.closingDelimiterRange ? [descriptor.closingDelimiterRange] : []),
        ...(descriptor.contentRange ? [descriptor.contentRange] : []),
      ];
    case "feature":
      return liveMdFeatureDescriptorRanges(descriptor.effect);
  }
}

export function liveMdDescriptorKey(descriptor: LiveMdDescriptor) {
  switch (descriptor.kind) {
    case "lineClass":
      return liveMdStableKeyParts("lineClass", rangeKey(descriptor.range), descriptor.className);
    case "syntax":
      return liveMdStableKeyParts("syntax", rangeKey(descriptor.range), descriptor.className);
    case "textMark":
      return liveMdStableKeyParts("textMark", rangeKey(descriptor.range), descriptor.mark);
    case "linkMark":
      return liveMdStableKeyParts(
        "linkMark",
        rangeKey(descriptor.range),
        rangeKey(descriptor.sourceRange),
        descriptor.destination,
      );
    case "listMarker":
      return liveMdStableKeyParts("listMarker", rangeKey(descriptor.range), descriptor.marker);
    case "taskMarker":
      return liveMdStableKeyParts("taskMarker", rangeKey(descriptor.range), descriptor.checked);
    case "image":
      return liveMdStableKeyParts(
        "image",
        rangeKey(descriptor.range),
        rangeKey(descriptor.lineRange),
        optionalRangeKey(descriptor.descriptionRange),
        optionalRangeKey(descriptor.destinationRange),
        descriptor.source,
        descriptor.alt,
      );
    case "latex":
      return liveMdStableKeyParts(
        "latex",
        rangeKey(descriptor.range),
        rangeKey(descriptor.formula.replacementRange),
        descriptor.formula.replacementRange.block,
        descriptor.formula.displayMode,
        descriptor.formula.source,
        descriptor.formula.tex,
      );
    case "table":
      return liveMdStableKeyParts(
        "table",
        rangeKey(descriptor.range),
        optionalRangeKey(descriptor.delimiterRowRange),
        descriptorsRangeKey(descriptor.pipeRanges),
        liveMdTableShapeKey(descriptor.table),
      );
    case "codeFence":
      return liveMdStableKeyParts(
        "codeFence",
        rangeKey(descriptor.range),
        rangeKey(descriptor.openingDelimiterRange),
        optionalRangeKey(descriptor.closingDelimiterRange),
        optionalRangeKey(descriptor.contentRange),
        descriptor.language,
        descriptor.mermaidSource,
      );
    case "feature":
      return liveMdStableKeyParts(
        "feature",
        descriptor.feature,
        liveMdFeatureDescriptorKey(descriptor.effect),
      );
  }
}

export function liveMdDescriptorsKey(descriptors: readonly LiveMdDescriptor[]) {
  return liveMdStableKeyParts(...descriptors.map(liveMdDescriptorKey));
}

export function liveMdFeatureDescriptorKey(descriptor: LiveMdFeatureDescriptor) {
  switch (descriptor.kind) {
    case "lineClass":
      return liveMdStableKeyParts("lineClass", rangeKey(descriptor.range), descriptor.className);
    case "mark":
      return liveMdStableKeyParts("mark", rangeKey(descriptor.range), descriptor.className);
    case "syntax":
      return liveMdStableKeyParts("syntax", rangeKey(descriptor.range), descriptor.className);
    case "replace":
      return liveMdStableKeyParts(
        "replace",
        rangeKey(descriptor.range),
        descriptor.block ?? false,
        descriptor.atomic ?? false,
        descriptor.widget.key,
      );
  }
}

export function liveMdTableShapeKey(table: LiveMdTableModel | null | undefined) {
  if (!table) return "";
  return liveMdStableKeyParts(
    table.header.length,
    table.alignments.join(","),
    table.rows.length,
    table.rows.map((row) => row.length).join(","),
  );
}

export function liveMdTableContentKey(table: LiveMdTableModel) {
  return liveMdStableKeyParts(
    "table",
    table.alignments.length,
    ...table.alignments,
    table.header.length,
    ...table.header,
    table.rows.length,
    ...table.rows.map((row) => liveMdStableKeyParts(row.length, ...row)),
  );
}

export function liveMdStableKeyParts(
  ...parts: readonly (boolean | number | string | null | undefined)[]
) {
  return parts
    .map((part) => {
      if (part === null) return "n:";
      if (part === undefined) return "u:";
      if (typeof part == "boolean") return `b:${part ? "1" : "0"}`;
      let text = String(part);
      return `${typeof part}:${text.length}:${text}`;
    })
    .join("|");
}

function descriptorsRangeKey(ranges: readonly DocRange[]) {
  return liveMdStableKeyParts(...ranges.map(rangeKey));
}

function rangeKey(range: DocRange) {
  return `${range.from}-${range.to}`;
}

function optionalRangeKey(range: DocRange | null) {
  return range ? rangeKey(range) : "";
}

function offsetLiveMdFeatureDescriptor(
  descriptor: LiveMdFeatureDescriptor,
  offset: number,
): LiveMdFeatureDescriptor {
  switch (descriptor.kind) {
    case "lineClass":
    case "mark":
    case "syntax":
      return { ...descriptor, range: offsetRange(descriptor.range, offset) };
    case "replace":
      return { ...descriptor, range: offsetRange(descriptor.range, offset) };
  }
}

function liveMdFeatureDescriptorRanges(descriptor: LiveMdFeatureDescriptor): DocRange[] {
  return [descriptor.range];
}

function offsetRange(range: DocRange, offset: number): DocRange {
  return { from: range.from + offset, to: range.to + offset };
}
