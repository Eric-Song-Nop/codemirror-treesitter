import { Facet, type EditorState, type Extension } from "@codemirror/state";
import type {
  SyntaxNode,
  TreeSitterQueryCapture,
  TreeSitterQueryMatch,
  TreeSitterQueryProperties,
} from "@codemirror-treesitter/language";
import type { Decoration, WidgetType } from "@codemirror/view";

export type LiveMdQueryTarget = "document" | "inline";

export type LiveMdFeatureQuery = Partial<Record<LiveMdQueryTarget, string>>;

export type LiveMdFeatureMatch = Omit<TreeSitterQueryMatch, "patternIndex"> & {
  patternIndex: number;
  target: LiveMdQueryTarget;
};

export type LiveMdSearchRange = {
  from: number;
  to: number;
};

export type LiveMdFeatureSearch = {
  hiddenQuery?: LiveMdFeatureQuery;
  isVisible?: (range: LiveMdSearchRange, context: LiveMdSearchContext) => boolean | undefined;
};

export type LiveMdFeature<State = unknown> = {
  collect?: (match: LiveMdFeatureMatch, featureState: State, context: LiveMdFeatureContext) => void;
  create?: (context: LiveMdFeatureCreateContext) => State;
  finish?: (featureState: State, context: LiveMdFeatureContext) => void;
  id: string;
  apply?: (match: LiveMdFeatureMatch, featureState: State, context: LiveMdFeatureContext) => void;
  priority?: number;
  query?: LiveMdFeatureQuery;
  search?: LiveMdFeatureSearch;
};

export type LiveMdFeatureCreateContext = {
  activeLines: ReadonlySet<number>;
  state: EditorState;
};

export type LiveMdFeatureContext = LiveMdFeatureCreateContext & {
  atomic: (from: number, to: number) => void;
  capture: (match: LiveMdFeatureMatch, name: string) => TreeSitterQueryCapture | null;
  captures: (match: LiveMdFeatureMatch, name: string) => readonly TreeSitterQueryCapture[];
  claim: (key: string) => boolean;
  consume: (from: number, to: number) => void;
  highlightCodeFence: (contentFrom: number, contentTo: number, language: string) => void;
  isConsumed: (from: number, to: number) => boolean;
  lineClassAt: (lineNumber: number, className: string) => void;
  lineClass: (from: number, to: number, className: string) => void;
  linkBaseUrl: string | null;
  mark: (from: number, to: number, decoration: Decoration) => void;
  nodeKey: (node: SyntaxNode) => string;
  onlyVisibleContentOnLine: (
    lineFrom: number,
    lineTo: number,
    contentFrom: number,
    contentTo: number,
  ) => boolean;
  replace: (from: number, to: number, widget: WidgetType, block?: boolean) => void;
  resolveImageSource: (source: string) => string;
  syntax: (from: number, to: number, decoration?: Decoration) => void;
  text: (node: SyntaxNode) => string;
  touchesActiveLine: (from: number, to: number) => boolean;
};

export type LiveMdSearchContext = {
  state: EditorState;
  text: (node: SyntaxNode) => string;
};

export type LiveMdFeatureQueryProperties = TreeSitterQueryProperties;

export const liveMdFeatureFacet = Facet.define<
  LiveMdFeature<unknown>,
  readonly LiveMdFeature<unknown>[]
>({
  combine(values) {
    return values.slice().sort((left, right) => (left.priority ?? 100) - (right.priority ?? 100));
  },
});

export function liveMdFeature<State>(feature: LiveMdFeature<State>): Extension {
  return liveMdFeatureFacet.of(feature as LiveMdFeature<unknown>);
}

export function liveMdFeatures(features: readonly LiveMdFeature<unknown>[]): Extension {
  return features.map(liveMdFeature);
}
