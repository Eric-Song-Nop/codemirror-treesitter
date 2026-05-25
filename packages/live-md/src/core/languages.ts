import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { TreeSitterLanguage, type TreeSitterParser } from "@codemirror-treesitter/language";
import { languages } from "@codemirror-treesitter/language-data";
import { gruvboxLightHighlightStyle } from "@codemirror-treesitter/theme-gruvbox";
import { EditorView } from "@codemirror/view";

export type CodeFenceLanguageMap = ReadonlyMap<string, TreeSitterParser>;

export const emptyCodeFenceLanguages: CodeFenceLanguageMap = new Map();
export const setCodeFenceLanguages = StateEffect.define<CodeFenceLanguageMap>();

export const codeFenceLanguagesField = StateField.define<CodeFenceLanguageMap>({
  create() {
    return emptyCodeFenceLanguages;
  },
  update(value, transaction) {
    for (let effect of transaction.effects) {
      if (effect.is(setCodeFenceLanguages)) return effect.value;
    }
    return value;
  },
});

export const codeFenceHighlightModule = gruvboxLightHighlightStyle.module
  ? EditorView.styleModule.of(gruvboxLightHighlightStyle.module)
  : [];

let markdownExtensionPromise: Promise<Extension> | null = null;
let codeFenceLanguagesPromise: Promise<CodeFenceLanguageMap> | null = null;

export function loadMarkdownExtension() {
  markdownExtensionPromise ??= loadMarkdownExtensionOnce();
  return markdownExtensionPromise;
}

export function loadCodeFenceLanguages() {
  codeFenceLanguagesPromise ??= loadCodeFenceLanguagesOnce();
  return codeFenceLanguagesPromise;
}

async function loadMarkdownExtensionOnce() {
  let markdownDescription = languages.find((language) => language.name == "Markdown");
  if (!markdownDescription) throw new Error("Markdown language support is unavailable");
  let support = await markdownDescription.load();
  return support.extension;
}

async function loadCodeFenceLanguagesOnce() {
  let languageMap = new Map<string, TreeSitterParser>();
  let aliasesByLanguage = new Map([
    ["CSS", ["css"]],
    ["HTML", ["html", "xhtml"]],
    ["JSON", ["json", "json5"]],
    ["JavaScript", ["javascript", "js", "jsx", "ecmascript", "node"]],
    ["Markdown", ["markdown", "md", "mkd"]],
    ["Python", ["python", "py"]],
    ["Shell", ["shell", "sh", "bash", "zsh"]],
    ["TSX", ["tsx"]],
    ["TypeScript", ["typescript", "ts", "mts", "cts"]],
  ]);

  await Promise.all(
    Array.from(aliasesByLanguage.keys()).map(async (name) => {
      let description = languages.find((language) => language.name == name);
      if (!description) return;

      let support = await description.load().catch(() => null);
      if (!support) return;
      if (!(support.language instanceof TreeSitterLanguage)) return;

      let parser = support.language.parser;
      let aliases = new Set([
        name.toLowerCase(),
        ...description.alias.map((alias) => alias.toLowerCase()),
        ...description.extensions.map((extension) => extension.toLowerCase()),
        ...(aliasesByLanguage.get(name) ?? []),
      ]);
      for (let alias of aliases) languageMap.set(alias, parser);
    }),
  );

  return languageMap;
}
