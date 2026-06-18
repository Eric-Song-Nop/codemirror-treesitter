import { Facet, type EditorState, type Extension } from "@codemirror/state";
import type { Decoration, WidgetType } from "@codemirror/view";
import type {
  SyntaxNode,
  TreeSitterQueryCapture,
  TreeSitterQueryMatch,
  TreeSitterQuerySource,
} from "@codemirror-treesitter/language";

export type LiveMdMarkdownConfig = {
  features?: readonly LiveMdMarkdownFeature[];
};

export type LiveMdFeatureDecoration = Decoration | string;

export type LiveMdFeatureReplaceOptions = {
  atomic?: boolean;
  block?: boolean;
};

export type LiveMdFeatureDecorateContext = {
  activeLines: ReadonlySet<number>;
  addAtomicRange: (from: number, to: number) => void;
  addLineClass: (from: number, to: number, className: string) => void;
  addMark: (from: number, to: number, decoration: LiveMdFeatureDecoration) => void;
  addReplace: (
    from: number,
    to: number,
    widget: WidgetType,
    options?: LiveMdFeatureReplaceOptions,
  ) => void;
  addSyntax: (from: number, to: number, decoration?: LiveMdFeatureDecoration) => void;
  capture: (name: string) => TreeSitterQueryCapture | null;
  captures: (name: string) => readonly TreeSitterQueryCapture[];
  match: TreeSitterQueryMatch;
  node: (name: string) => SyntaxNode | null;
  nodes: (name: string) => readonly SyntaxNode[];
  rangeTouchesActiveLine: (from: number, to: number) => boolean;
  slice: (node: SyntaxNode) => string;
  state: EditorState;
};

export type LiveMdFeatureHtmlRenderResult =
  | Promise<string | null | undefined>
  | string
  | null
  | undefined;

export type LiveMdFeatureHtmlRenderContext = {
  capture: (name: string) => TreeSitterQueryCapture | null;
  captures: (name: string) => readonly TreeSitterQueryCapture[];
  match: TreeSitterQueryMatch;
  node: (name: string) => SyntaxNode | null;
  nodes: (name: string) => readonly SyntaxNode[];
  renderChildren: (node?: SyntaxNode) => Promise<string>;
  renderDefault: () => Promise<string>;
  renderInline: (sourceOrNode: string | SyntaxNode) => Promise<string>;
  slice: (node: SyntaxNode) => string;
  source: string;
  target: SyntaxNode;
};

export type LiveMdMarkdownFeature = {
  decorate?: (context: LiveMdFeatureDecorateContext) => void;
  includeNested?: boolean;
  name: string;
  priority?: number;
  query?: TreeSitterQuerySource;
  renderHtml?: (context: LiveMdFeatureHtmlRenderContext) => LiveMdFeatureHtmlRenderResult;
};

export const liveMdMarkdownFeatureFacet = Facet.define<
  LiveMdMarkdownFeature,
  readonly LiveMdMarkdownFeature[]
>({
  combine(values) {
    return sortLiveMdMarkdownFeatures(values);
  },
});

export function liveMdMarkdownFeature(feature: LiveMdMarkdownFeature): LiveMdMarkdownFeature {
  return feature;
}

export function liveMdMarkdownFeatures(
  features: readonly LiveMdMarkdownFeature[] | null | undefined,
): Extension {
  return features?.map((feature) => liveMdMarkdownFeatureFacet.of(feature)) ?? [];
}

export function sortLiveMdMarkdownFeatures(features: readonly LiveMdMarkdownFeature[]) {
  return features.slice().sort(compareLiveMdMarkdownFeatures);
}

function compareLiveMdMarkdownFeatures(left: LiveMdMarkdownFeature, right: LiveMdMarkdownFeature) {
  return (left.priority ?? 0) - (right.priority ?? 0) || left.name.localeCompare(right.name);
}
