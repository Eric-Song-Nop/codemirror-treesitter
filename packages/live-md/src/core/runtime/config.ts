import type { EditorState } from "@codemirror/state";
import { syntaxHighlighters, type Highlighter } from "@codemirror-treesitter/language";
import type { CodeFenceLanguageMap } from "../languages.js";
import {
  codeFenceHighlighterFacet,
  codeFenceLanguagesField,
  emptyCodeFenceLanguages,
  liveMdDefaultCodeFenceHighlighter,
} from "../languages.js";
import { liveMdMarkdownFeatureFacet, type LiveMdMarkdownFeature } from "../features.js";
import { liveMdImageSourceResolver, type LiveMdImageSourceResolver } from "../images.js";
import { liveMdLinkBaseUrl } from "../links.js";

export type LiveMdRuntimeConfig = {
  codeFenceHighlighters: readonly Highlighter[];
  codeFenceLanguages: CodeFenceLanguageMap;
  imageSourceResolver: LiveMdImageSourceResolver | null;
  linkBaseUrl: string | null;
  markdownFeatures: readonly LiveMdMarkdownFeature[];
};

const defaultCodeFenceHighlighters = [liveMdDefaultCodeFenceHighlighter] as const;

export function readLiveMdRuntimeConfig(state: EditorState): LiveMdRuntimeConfig {
  return {
    codeFenceHighlighters:
      state.facet(codeFenceHighlighterFacet) ??
      syntaxHighlighters(state) ??
      defaultCodeFenceHighlighters,
    codeFenceLanguages: state.field(codeFenceLanguagesField, false) ?? emptyCodeFenceLanguages,
    imageSourceResolver: state.facet(liveMdImageSourceResolver),
    linkBaseUrl: state.facet(liveMdLinkBaseUrl),
    markdownFeatures: state.facet(liveMdMarkdownFeatureFacet),
  };
}

export function sameLiveMdRuntimeConfig(left: LiveMdRuntimeConfig, right: LiveMdRuntimeConfig) {
  return (
    left.codeFenceLanguages == right.codeFenceLanguages &&
    left.imageSourceResolver == right.imageSourceResolver &&
    left.linkBaseUrl == right.linkBaseUrl &&
    sameLiveMdArrayItems(left.codeFenceHighlighters, right.codeFenceHighlighters) &&
    sameLiveMdArrayItems(left.markdownFeatures, right.markdownFeatures)
  );
}

function sameLiveMdArrayItems<T>(left: readonly T[], right: readonly T[]) {
  if (left.length != right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] != right[index]) return false;
  }
  return true;
}
