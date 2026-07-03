import { EditorState, type Extension } from "@codemirror/state";
import { closeBrackets, closeBracketsKeymap } from "@codemirror-treesitter/autocomplete";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { liveMdKeymap } from "./commands.js";
import { liveMdEditContinuationField } from "./edit-continuation.js";
import { liveMdAnalysis } from "./runtime/field.js";
import { liveMdMarkdownFeatures, type LiveMdMarkdownConfig } from "./features.js";
import { liveMdImageSource, type LiveMdImageSourceResolver } from "./images.js";
import { codeFenceLanguagesField, liveMdDefaultCodeFenceHighlighting } from "./languages.js";
import { liveMdLinkBase, liveMdLinkInteractions, type LiveMdLinkBaseUrl } from "./links.js";
import { liveMdSearch } from "./search.js";

export type LiveMarkdownOptions = {
  ariaLabel?: string;
  className?: string;
  imageSource?: LiveMdImageSourceResolver | null;
  linkBaseUrl?: LiveMdLinkBaseUrl | null;
  markdown?: LiveMdMarkdownConfig;
  placeholder?: string;
  spellcheck?: boolean;
};

export function liveMarkdown(options: LiveMarkdownOptions = {}): Extension {
  let extensions: Extension[] = [
    liveMdKeymap,
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    codeFenceLanguagesField,
    liveMdDefaultCodeFenceHighlighting,
    EditorView.contentAttributes.of({
      "aria-label": options.ariaLabel ?? "LiveMD Markdown editor",
      spellcheck: String(options.spellcheck ?? true),
    }),
    EditorView.editorAttributes.of({
      class: options.className ?? "live-md-codemirror",
    }),
    liveMdLinkBase(options.linkBaseUrl),
    liveMdImageSource(options.imageSource),
    liveMdMarkdownFeatures(options.markdown?.features),
    liveMdLinkInteractions(),
    liveMdSearch,
    liveMdEditContinuationField,
    liveMdAnalysis,
  ];

  if (options.placeholder) extensions.push(placeholderExtension(options.placeholder));
  return extensions;
}
