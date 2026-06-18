import type { RangeSet, RangeValue, Text } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import type {
  SyntaxNode,
  Tree,
  TreeSitterParser,
  TreeSitterQueryMatch,
  TreeSitterQueryProperties,
} from "@codemirror-treesitter/language";
import type { LiveMdProjectionCache } from "../projection/index.js";

export type LiveMdDocRange = {
  from: number;
  to: number;
};

export type LiveMdUnitId = string & { readonly __liveMdUnitId: unique symbol };

export type LiveMdSemanticCapture = {
  name: string;
  nodeName: string;
  patternIndex: number;
  range: LiveMdDocRange;
};

export type LiveMdSemanticSource = {
  captures: readonly LiveMdSemanticCapture[];
  matchKind: string | null;
  nodeName: string;
  patternIndex: number | null;
  properties: TreeSitterQueryProperties | null;
};

export type LiveMdSemanticUnitBase<Kind extends string> = {
  captures: readonly LiveMdSemanticCapture[];
  id: LiveMdUnitId;
  kind: Kind;
  ownerId: LiveMdUnitId;
  ownerRange: LiveMdDocRange;
  previousId?: LiveMdUnitId;
  range: LiveMdDocRange;
  signature: string;
  source: LiveMdSemanticSource;
};

export type LiveMdBlockquoteUnit = LiveMdSemanticUnitBase<"blockquote">;

export type LiveMdCodeFenceUnit = LiveMdSemanticUnitBase<"codeFence"> & {
  closeRange: LiveMdDocRange | null;
  contentRange: LiveMdDocRange | null;
  language: string;
  languageRange: LiveMdDocRange | null;
  openRange: LiveMdDocRange | null;
};

export type LiveMdHeadingUnit = LiveMdSemanticUnitBase<"heading"> & {
  level: number;
  markerRange: LiveMdDocRange | null;
};

export type LiveMdImageUnit = LiveMdSemanticUnitBase<"image"> & {
  altRange: LiveMdDocRange | null;
  destinationRange: LiveMdDocRange | null;
};

export type LiveMdInlineMarkKind = "emphasis" | "inlineCode" | "strike" | "strong" | "unknown";

export type LiveMdInlineMarkUnit = LiveMdSemanticUnitBase<"inlineMark"> & {
  mark: LiveMdInlineMarkKind;
};

export type LiveMdLatexUnit = LiveMdSemanticUnitBase<"latex"> & {
  closeRange: LiveMdDocRange | null;
  openRange: LiveMdDocRange | null;
};

export type LiveMdLineSyntaxUnit = LiveMdSemanticUnitBase<"syntax"> & {
  captureName: string;
};

export type LiveMdLinkUnit = LiveMdSemanticUnitBase<"link"> & {
  destinationRange: LiveMdDocRange | null;
  textRange: LiveMdDocRange | null;
};

export type LiveMdListItemUnit = LiveMdSemanticUnitBase<"listItem">;

export type LiveMdListMarkerUnit = LiveMdSemanticUnitBase<"listMarker"> & {
  marker: string;
};

export type LiveMdParagraphContainerKind = "block" | "document" | "list" | "listItem";

export type LiveMdParagraphContainerUnit = LiveMdSemanticUnitBase<"paragraphContainer"> & {
  childRange: LiveMdDocRange;
  containerKind: LiveMdParagraphContainerKind;
};

export type LiveMdParagraphBreakUnit = LiveMdSemanticUnitBase<"paragraphBreak"> & {
  breakRanges: readonly LiveMdDocRange[];
};

export type LiveMdRuleUnit = LiveMdSemanticUnitBase<"rule">;

export type LiveMdTableUnit = LiveMdSemanticUnitBase<"table"> & {
  delimiterRowRange: LiveMdDocRange | null;
};

export type LiveMdTaskMarkerUnit = LiveMdSemanticUnitBase<"taskMarker"> & {
  checked: boolean;
};

export type LiveMdUriAutolinkUnit = LiveMdSemanticUnitBase<"uriAutolink">;

export type LiveMdUnknownCaptureUnit = LiveMdSemanticUnitBase<"capture"> & {
  captureName: string;
};

export type LiveMdSemanticUnit =
  | LiveMdBlockquoteUnit
  | LiveMdCodeFenceUnit
  | LiveMdHeadingUnit
  | LiveMdImageUnit
  | LiveMdInlineMarkUnit
  | LiveMdLatexUnit
  | LiveMdLineSyntaxUnit
  | LiveMdLinkUnit
  | LiveMdListItemUnit
  | LiveMdListMarkerUnit
  | LiveMdParagraphBreakUnit
  | LiveMdParagraphContainerUnit
  | LiveMdRuleUnit
  | LiveMdTableUnit
  | LiveMdTaskMarkerUnit
  | LiveMdUriAutolinkUnit
  | LiveMdUnknownCaptureUnit;

export type LiveMdOwnerRange = {
  id: LiveMdUnitId;
  range: LiveMdDocRange;
};

export type LiveMdSemanticIndex = {
  activeLines: ReadonlySet<number>;
  docLength: number;
  ownerRanges: readonly LiveMdOwnerRange[];
  queryRanges: readonly LiveMdDocRange[];
  ranges: readonly LiveMdDocRange[];
  tree: Tree;
  units: readonly LiveMdSemanticUnit[];
  unitsById: ReadonlyMap<LiveMdUnitId, LiveMdSemanticUnit>;
  unitsByOwnerId: ReadonlyMap<LiveMdUnitId, readonly LiveMdSemanticUnit[]>;
};

export type LiveMdInvalidationReason =
  | "config"
  | "doc"
  | "init"
  | "selection"
  | "tree"
  | "viewport";

export type LiveMdInvalidation = {
  dirtyOwnerRanges: readonly LiveMdDocRange[];
  dirtyRanges: readonly LiveMdDocRange[];
  mappedPreviousUnits: readonly LiveMdSemanticUnit[];
  reasons: readonly LiveMdInvalidationReason[];
};

export type LiveMdCodeFenceHighlightTree = {
  contentFrom: number;
  contentTo: number;
  language: string;
  parser: TreeSitterParser;
  sourceText: Text;
  tree: Tree;
};

export type LiveMdRuntimeSnapshot = {
  activeLines: ReadonlySet<number>;
  atomicRanges: RangeSet<RangeValue>;
  codeFenceHighlightTrees: readonly LiveMdCodeFenceHighlightTree[];
  decorations: DecorationSet;
  invalidation: LiveMdInvalidation;
  projectionCache: LiveMdProjectionCache;
  ranges: readonly LiveMdDocRange[];
  semanticIndex: LiveMdSemanticIndex;
  tree: Tree;
  version: number;
  visibleRanges: readonly LiveMdDocRange[];
};

export type LiveMdMatchedQuery = {
  match: TreeSitterQueryMatch;
  range: LiveMdDocRange;
};

export type LiveMdNodeLike = Pick<SyntaxNode, "from" | "id" | "name" | "to">;
