import { Facet, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  HighlightStyle,
  TreeSitterLanguage,
  tags as t,
  type Highlighter,
  type TreeSitterParser,
} from "@codemirror-treesitter/language";
import { languages } from "@codemirror-treesitter/language-data";
import { EditorView } from "@codemirror/view";

export type CodeFenceLanguageMap = ReadonlyMap<string, TreeSitterParser>;

export const emptyCodeFenceLanguages: CodeFenceLanguageMap = new Map();
export const setCodeFenceLanguages = StateEffect.define<CodeFenceLanguageMap>();

const neutralCodeFenceHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#9b392b" },
  { tag: [t.name, t.definition(t.name), t.separator], color: "#2f3437" },
  { tag: [t.function(t.variableName), t.labelName], color: "#0f6a85" },
  { tag: [t.propertyName, t.attributeName], color: "#0f6a85" },
  { tag: [t.number, t.constant(t.name), t.standard(t.name)], color: "#8b4a35" },
  { tag: [t.typeName, t.className, t.annotation, t.modifier], color: "#8d3525" },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link], color: "#0f766e" },
  { tag: [t.meta, t.comment], color: "#66706c" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.heading, fontWeight: "bold", color: "#13231f" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#6d4b8f" },
  { tag: [t.processingInstruction, t.string, t.inserted, t.special(t.string)], color: "#0f766e" },
  { tag: [t.deleted, t.invalid], color: "#9b392b" },
]);

export const codeFenceHighlighterFacet = Facet.define<
  Highlighter | readonly Highlighter[],
  readonly Highlighter[] | null
>({
  combine(values) {
    let value = values.at(-1);
    if (!value) return null;
    return Array.isArray(value) ? value : [value];
  },
});

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

export function liveMdCodeFenceHighlighting(highlighter: Highlighter): Extension {
  let extensions: Extension[] = [codeFenceHighlighterFacet.of(highlighter)];
  if (highlighter instanceof HighlightStyle && highlighter.module) {
    extensions.push(EditorView.styleModule.of(highlighter.module));
  }
  return extensions;
}

export const liveMdDefaultCodeFenceHighlighter = neutralCodeFenceHighlightStyle;

export const liveMdDefaultCodeFenceHighlighting: Extension = neutralCodeFenceHighlightStyle.module
  ? [EditorView.styleModule.of(neutralCodeFenceHighlightStyle.module)]
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
