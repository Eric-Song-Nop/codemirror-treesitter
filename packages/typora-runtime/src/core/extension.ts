import { EditorState, type Extension } from "@codemirror/state";
import { closeBrackets, closeBracketsKeymap } from "@codemirror-treesitter/autocomplete";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { typoraKeymap } from "./commands.js";
import { typoraDecorations } from "./decorations.js";
import { codeFenceLanguagesField } from "./languages.js";

export type TyporaMarkdownOptions = {
  ariaLabel?: string;
  className?: string;
  placeholder?: string;
  spellcheck?: boolean;
};

export function typoraMarkdown(options: TyporaMarkdownOptions = {}): Extension {
  let extensions: Extension[] = [
    typoraKeymap,
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    codeFenceLanguagesField,
    EditorView.contentAttributes.of({
      "aria-label": options.ariaLabel ?? "Typora-style Markdown editor",
      spellcheck: String(options.spellcheck ?? true),
    }),
    EditorView.editorAttributes.of({
      class: options.className ?? "typora-codemirror",
    }),
    typoraDecorations,
  ];

  if (options.placeholder) extensions.push(placeholderExtension(options.placeholder));
  return extensions;
}
