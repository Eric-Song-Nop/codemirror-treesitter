import type { EditorState, RangeSet, RangeValue, Text } from "@codemirror/state";
import type { Highlighter, Tree, TreeSitterParser } from "@codemirror-treesitter/language";
import type { Decoration, DecorationSet } from "@codemirror/view";
import type { LiveMdDocRange } from "../analysis/index.js";
import type { LiveMdMarkdownFeature } from "../features.js";
import type { LiveMdImageSourceResolver } from "../images.js";
import type { CodeFenceLanguageMap } from "../languages.js";

export type LiveMdProjectionInput = {
  readonly activeLines: ReadonlySet<number>;
  readonly codeFenceHighlighters: readonly Highlighter[];
  readonly codeFenceLanguages: CodeFenceLanguageMap;
  readonly imageSourceResolver?: LiveMdImageSourceResolver | null;
  readonly linkBaseUrl?: string | null;
  readonly markdownFeatures?: readonly LiveMdMarkdownFeature[];
  readonly ranges: readonly LiveMdDocRange[];
  readonly state: EditorState;
};

export type LiveMdProjectionOutput = {
  readonly atomicRanges: RangeSet<RangeValue>;
  readonly codeFenceParses: readonly CodeFenceParseResult[];
  readonly decorations: DecorationSet;
};

export type LiveMdProjectionDecoration = Decoration | string;

export type LiveMdCacheableSemanticUnit = {
  readonly id: string;
  readonly signature: string;
};

export type LiveMdCodeFenceParseUnit = LiveMdCacheableSemanticUnit & {
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly language: string;
};

export type CodeFenceParseResult = {
  readonly cacheKey: string;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly language: string;
  readonly parser: TreeSitterParser;
  readonly parserIdentity: string;
  readonly signature: string;
  readonly sourceText: Text;
  readonly tree: Tree;
  readonly unitId: string;
};
