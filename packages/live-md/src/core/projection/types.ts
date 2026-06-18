import type { EditorState, RangeSet, RangeValue } from "@codemirror/state";
import type { Highlighter, Tree, TreeSitterParser } from "@codemirror-treesitter/language";
import type { Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import type { LiveMdImageSourceResolver } from "../images.js";
import type { CodeFenceLanguageMap } from "../languages.js";
import type { LatexFormula, MarkdownTable, MermaidDiagram } from "../widgets.js";

export type LiveMdProjectionRange = {
  readonly from: number;
  readonly to: number;
};

export type LiveMdProjectionInput = {
  readonly activeLines: ReadonlySet<number>;
  readonly codeFenceHighlighters: readonly Highlighter[];
  readonly codeFenceLanguages: CodeFenceLanguageMap;
  readonly imageSourceResolver?: LiveMdImageSourceResolver | null;
  readonly linkBaseUrl?: string | null;
  readonly ranges: readonly LiveMdProjectionRange[];
  readonly state: EditorState;
};

export type LiveMdProjectionOutput = {
  readonly atomicRanges: RangeSet<RangeValue>;
  readonly codeFenceParses: readonly CodeFenceParseResult[];
  readonly decorations: DecorationSet;
};

export type LiveMdCacheableSemanticUnit = {
  readonly id: string;
  readonly signature: string;
};

export type LiveMdSemanticUnitBase = LiveMdCacheableSemanticUnit & {
  readonly from: number;
  readonly to: number;
};

export type LiveMdProjectionDecoration = Decoration | string;

export type LiveMdSemanticMarkUnit = LiveMdSemanticUnitBase & {
  readonly className?: string;
  readonly decoration?: LiveMdProjectionDecoration;
  readonly kind: "mark";
};

export type LiveMdSemanticLinkUnit = LiveMdSemanticUnitBase & {
  readonly destination: string | null;
  readonly kind: "link";
};

export type LiveMdSemanticReplaceUnit = LiveMdSemanticUnitBase & {
  readonly atomic?: boolean;
  readonly block?: boolean;
  readonly kind: "replace";
  readonly widget: WidgetType;
};

export type LiveMdSemanticLineClassUnit = LiveMdCacheableSemanticUnit & {
  readonly className: string;
  readonly from?: number;
  readonly kind: "lineClass";
  readonly line?: number;
  readonly to?: number;
};

export type LiveMdSemanticSyntaxUnit = LiveMdSemanticUnitBase & {
  readonly hiddenDecoration?: LiveMdProjectionDecoration;
  readonly kind: "syntax";
  readonly visibleDecoration?: LiveMdProjectionDecoration;
};

export type LiveMdSemanticAtomicParagraphGapUnit = LiveMdSemanticUnitBase & {
  readonly className?: string;
  readonly kind: "atomicParagraphGap";
  readonly line?: number;
};

export type LiveMdSemanticCodeFenceUnit = LiveMdSemanticUnitBase & {
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly kind: "codeFence";
  readonly language: string;
  readonly source?: string;
};

export type LiveMdSemanticMermaidUnit = LiveMdSemanticUnitBase & {
  readonly block?: boolean;
  readonly diagram: MermaidDiagram;
  readonly kind: "mermaid";
};

export type LiveMdSemanticLatexUnit = LiveMdSemanticUnitBase & {
  readonly formula: LatexFormula;
  readonly kind: "latex";
};

export type LiveMdSemanticImageUnit = LiveMdSemanticUnitBase & {
  readonly alt: string;
  readonly atomic?: boolean;
  readonly block?: boolean;
  readonly kind: "image";
  readonly src: string;
};

export type LiveMdSemanticTableUnit = LiveMdSemanticUnitBase & {
  readonly kind: "table";
  readonly table: MarkdownTable;
};

export type LiveMdSemanticTaskMarkerUnit = LiveMdSemanticUnitBase & {
  readonly checked: boolean;
  readonly kind: "taskMarker";
};

export type LiveMdSemanticListMarkerUnit = LiveMdSemanticUnitBase & {
  readonly kind: "listMarker";
  readonly marker: string;
};

export type LiveMdSemanticUnit =
  | LiveMdSemanticAtomicParagraphGapUnit
  | LiveMdSemanticCodeFenceUnit
  | LiveMdSemanticImageUnit
  | LiveMdSemanticLatexUnit
  | LiveMdSemanticLineClassUnit
  | LiveMdSemanticLinkUnit
  | LiveMdSemanticListMarkerUnit
  | LiveMdSemanticMarkUnit
  | LiveMdSemanticMermaidUnit
  | LiveMdSemanticReplaceUnit
  | LiveMdSemanticSyntaxUnit
  | LiveMdSemanticTableUnit
  | LiveMdSemanticTaskMarkerUnit;

export type LiveMdSemanticDocument = {
  readonly units: readonly LiveMdSemanticUnit[];
};

export type LiveMdSemanticInput = LiveMdSemanticDocument | readonly LiveMdSemanticUnit[];

export type CodeFenceParseResult = {
  readonly cacheKey: string;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly language: string;
  readonly parser: TreeSitterParser;
  readonly parserIdentity: string;
  readonly signature: string;
  readonly sourceText: import("@codemirror/state").Text;
  readonly tree: Tree;
  readonly unitId: string;
};
