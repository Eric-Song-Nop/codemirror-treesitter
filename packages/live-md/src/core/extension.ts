import { EditorState, type Extension } from "@codemirror/state";
import { closeBrackets, closeBracketsKeymap } from "@codemirror-treesitter/autocomplete";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { liveMdKeymap } from "./commands.js";
import { liveMdAnalysis } from "./decorations.js";
import { liveMdImageSource, type LiveMdImageSourceResolver } from "./images.js";
import { codeFenceLanguagesField } from "./languages.js";
import { liveMdLinkBase, liveMdLinkInteractions, type LiveMdLinkBaseUrl } from "./links.js";
import { liveMdSearch } from "./search.js";

export type LiveMarkdownOptions = {
  ariaLabel?: string;
  className?: string;
  imageSource?: LiveMdImageSourceResolver | null;
  linkBaseUrl?: LiveMdLinkBaseUrl | null;
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
    EditorView.contentAttributes.of({
      "aria-label": options.ariaLabel ?? "LiveMD Markdown editor",
      spellcheck: String(options.spellcheck ?? true),
    }),
    EditorView.editorAttributes.of({
      class: options.className ?? "live-md-codemirror",
    }),
    liveMdLinkBase(options.linkBaseUrl),
    liveMdImageSource(options.imageSource),
    liveMdLinkInteractions(),
    liveMdSearch,
    liveMdAnalysis,
  ];

  if (options.placeholder) extensions.push(placeholderExtension(options.placeholder));
  return extensions;
}
