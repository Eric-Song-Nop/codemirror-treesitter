import { EditorState, type Extension } from "@codemirror/state";
import { closeBrackets, closeBracketsKeymap } from "@codemirror-treesitter/autocomplete";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { liveMdKeymap } from "./commands.js";
import { liveMdAtomicRanges, liveMdDecorations } from "./decorations.js";
import { codeFenceLanguagesField } from "./languages.js";

export type LiveMarkdownOptions = {
  ariaLabel?: string;
  className?: string;
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
    liveMdDecorations,
    liveMdAtomicRanges,
  ];

  if (options.placeholder) extensions.push(placeholderExtension(options.placeholder));
  return extensions;
}
