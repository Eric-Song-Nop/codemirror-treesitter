import { type MarkdownBlockContext, type MarkdownLeafKind } from "./markdown-block-types.js";
import { type DocRange } from "./types.js";

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
    };

export type LeafAnalysis = {
  analysisKey: string;
  descriptors: readonly LiveMdDescriptor[];
  renderKey: string;
  structuralEffects: readonly LiveMdDescriptor[];
};

export type LeafAnalysisRecord = {
  analysis: LeafAnalysis;
  context: MarkdownBlockContext;
  contextKey: string;
  kind: MarkdownLeafKind | "marker";
  range: DocRange;
  sourceRange: DocRange;
};
