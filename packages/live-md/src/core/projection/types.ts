import { type EditorState, type Text } from "@codemirror/state";
import { type Highlighter } from "@codemirror-treesitter/language";
import { type Decoration, type WidgetType } from "@codemirror/view";
import { type LiveMdTableModel, type LiveMdTextMarkKind } from "../analysis/descriptors.js";
import { type LiveMdLeafAnalysisTrace } from "../analysis/types.js";
import { type LiveMdMarkdownFeature } from "../features.js";
import { type LiveMdImageSourceResolver } from "../images.js";
import { type CodeFenceLanguageMap } from "../languages.js";
import { type DocRange } from "../analysis/types.js";

export type LiveMdBuild = {
  activeLines: Set<number>;
  activeSourceRanges: readonly DocRange[];
  codeFenceHighlighters: readonly Highlighter[];
  codeFenceLanguages: CodeFenceLanguageMap;
  effects: LiveMdEffect[];
  imageSourceResolver: LiveMdImageSourceResolver | null;
  linkBaseUrl: string | null;
  markdownFeatures: readonly LiveMdMarkdownFeature[];
  sourceIslandMode: boolean;
  state: EditorState;
  trace: LiveMdLeafAnalysisTrace;
};

export type LiveMdBuildConfig = {
  activeLines: Set<number>;
  activeSourceRanges?: readonly DocRange[];
  codeFenceHighlighters: readonly Highlighter[];
  codeFenceLanguages: CodeFenceLanguageMap;
  imageSourceResolver: LiveMdImageSourceResolver | null;
  linkBaseUrl: string | null;
  markdownFeatures: readonly LiveMdMarkdownFeature[];
  sourceIslandMode?: boolean;
  state: EditorState;
  trace?: LiveMdLeafAnalysisTrace;
};

export type CodeFenceParser =
  CodeFenceLanguageMap extends ReadonlyMap<string, infer Parser> ? Parser : never;

export type LiveMdEffect =
  | {
      decoration: Decoration;
      from: number;
      kind: "mark";
      to: number;
    }
  | {
      block?: boolean;
      from: number;
      kind: "replace";
      atomic?: boolean;
      to: number;
      widget: WidgetType;
    }
  | {
      className: string;
      from: number;
      kind: "lineClass";
      to: number;
    }
  | {
      decoration?: Decoration;
      from: number;
      kind: "syntax";
      to: number;
    }
  | {
      from: number;
      kind: "atomic";
      to: number;
    };

export type LiveMdRenderStatus = {
  activeLines: ReadonlySet<number>;
  activeSource: boolean;
  activeSourceRanges: readonly DocRange[];
  doc: Text;
  sourceIslandMode: boolean;
};

export type LiveMdMarkSpec =
  | {
      className: string;
      kind: "class";
    }
  | {
      destination: string | null;
      kind: "link";
    }
  | {
      kind: "text";
      mark: LiveMdTextMarkKind;
    };

export type LiveMdWidgetSpec =
  | {
      kind: "imagePreview";
      alt: string;
      source: string;
    }
  | {
      kind: "latex";
      block: boolean;
      displayMode: boolean;
      source: string;
      tex: string;
    }
  | {
      kind: "listMarker";
      marker: string;
    }
  | {
      kind: "mermaid";
      source: string;
    }
  | {
      kind: "tablePreview";
      table: LiveMdTableModel;
    }
  | {
      checked: boolean;
      kind: "taskMarker";
    };

export type LiveMdEffectSpec =
  | {
      from: number;
      kind: "atomic";
      to: number;
    }
  | {
      contentFrom: number;
      contentTo: number;
      kind: "codeFenceHighlight";
      language: string;
    }
  | {
      className: string;
      from: number;
      kind: "lineClass";
      to: number;
    }
  | {
      from: number;
      kind: "mark";
      mark: LiveMdMarkSpec;
      to: number;
    }
  | {
      atomic?: boolean;
      block?: boolean;
      from: number;
      kind: "replace";
      to: number;
      widget: LiveMdWidgetSpec;
    }
  | {
      className?: string;
      from: number;
      kind: "syntax";
      to: number;
    };
