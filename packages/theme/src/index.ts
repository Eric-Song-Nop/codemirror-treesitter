import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, tags as t } from "@codemirror-treesitter/language";

export type ThemeAppearance = "dark" | "light";

export type EditorChromeColors = {
  activeLine: string;
  background: string;
  border: string;
  cursor: string;
  foldPlaceholderBorder: string;
  foldPlaceholderText: string;
  foreground: string;
  gutterActiveBackground: string;
  gutterActiveForeground: string;
  gutterBackground: string;
  gutterBorder: string;
  gutterForeground: string;
  matchingBracketBackground: string;
  matchingBracketBorder: string;
  nonmatchingBracketBackground: string;
  nonmatchingBracketBorder: string;
  panelBackground: string;
  panelBorder: string;
  panelForeground: string;
  searchMatch: string;
  searchMatchBorder: string;
  searchMatchSelected: string;
  selection: string;
  selectionMatch: string;
  tooltipBackground: string;
  tooltipBorder: string;
  tooltipForeground: string;
  tooltipSelectedBackground: string;
  tooltipSelectedForeground: string;
};

export type EditorSyntaxColors = {
  atom: string;
  bool: string;
  character: string;
  className: string;
  comment: string;
  constant: string;
  definition: string;
  deleted: string;
  escape: string;
  functionName: string;
  heading: string;
  inserted: string;
  invalid: string;
  keyword: string;
  labelName: string;
  link: string;
  macroName: string;
  meta: string;
  modifier: string;
  namespace: string;
  number: string;
  operator: string;
  propertyName: string;
  regexp: string;
  separator: string;
  specialString: string;
  specialVariable: string;
  standardName: string;
  string: string;
  typeName: string;
  url: string;
  variableName: string;
};

export type SemanticThemeSpec = {
  appearance: ThemeAppearance;
  chrome: EditorChromeColors;
  syntax: EditorSyntaxColors;
};

export function createEditorTheme({ appearance, chrome }: SemanticThemeSpec) {
  return EditorView.theme(
    {
      "&": {
        color: chrome.foreground,
        backgroundColor: chrome.background,
      },
      ".cm-content": {
        caretColor: chrome.cursor,
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: chrome.cursor,
        borderLeftWidth: "2px",
      },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: chrome.selection,
        },
      ".cm-panels": {
        backgroundColor: chrome.panelBackground,
        color: chrome.panelForeground,
      },
      ".cm-panels.cm-panels-top": {
        borderBottom: `1px solid ${chrome.panelBorder}`,
      },
      ".cm-panels.cm-panels-bottom": {
        borderTop: `1px solid ${chrome.panelBorder}`,
      },
      ".cm-searchMatch": {
        backgroundColor: chrome.searchMatch,
        outline: `1px solid ${chrome.searchMatchBorder}`,
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: chrome.searchMatchSelected,
      },
      ".cm-activeLine": {
        backgroundColor: chrome.activeLine,
      },
      ".cm-selectionMatch": {
        backgroundColor: chrome.selectionMatch,
      },
      "&.cm-focused .cm-matchingBracket": {
        backgroundColor: chrome.matchingBracketBackground,
        outline: `1px solid ${chrome.matchingBracketBorder}`,
      },
      "&.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: chrome.nonmatchingBracketBackground,
        outline: `1px solid ${chrome.nonmatchingBracketBorder}`,
      },
      ".cm-gutters": {
        backgroundColor: chrome.gutterBackground,
        color: chrome.gutterForeground,
        borderRight: `1px solid ${chrome.gutterBorder}`,
      },
      ".cm-activeLineGutter": {
        backgroundColor: chrome.gutterActiveBackground,
        color: chrome.gutterActiveForeground,
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: `1px solid ${chrome.foldPlaceholderBorder}`,
        color: chrome.foldPlaceholderText,
      },
      ".cm-tooltip": {
        border: `1px solid ${chrome.tooltipBorder}`,
        backgroundColor: chrome.tooltipBackground,
        color: chrome.tooltipForeground,
      },
      ".cm-tooltip .cm-tooltip-arrow:before": {
        borderTopColor: chrome.tooltipBorder,
        borderBottomColor: chrome.tooltipBorder,
      },
      ".cm-tooltip .cm-tooltip-arrow:after": {
        borderTopColor: chrome.tooltipBackground,
        borderBottomColor: chrome.tooltipBackground,
      },
      ".cm-tooltip-autocomplete": {
        "& > ul > li[aria-selected]": {
          backgroundColor: chrome.tooltipSelectedBackground,
          color: chrome.tooltipSelectedForeground,
        },
      },
    },
    { dark: appearance == "dark" },
  );
}

export function createHighlightStyle(syntax: EditorSyntaxColors) {
  return HighlightStyle.define([
    { tag: t.keyword, color: syntax.keyword },
    { tag: t.name, color: syntax.variableName },
    { tag: t.deleted, color: syntax.deleted },
    { tag: t.character, color: syntax.character },
    { tag: t.macroName, color: syntax.macroName },
    { tag: t.propertyName, color: syntax.propertyName },
    { tag: t.attributeName, color: syntax.propertyName },
    { tag: t.function(t.variableName), color: syntax.functionName },
    { tag: t.labelName, color: syntax.labelName },
    { tag: t.color, color: syntax.constant },
    { tag: t.constant(t.name), color: syntax.constant },
    { tag: t.standard(t.name), color: syntax.standardName },
    { tag: t.definition(t.name), color: syntax.definition },
    { tag: t.separator, color: syntax.separator },
    { tag: t.typeName, color: syntax.typeName },
    { tag: t.className, color: syntax.className },
    { tag: t.number, color: syntax.number },
    { tag: t.changed, color: syntax.modifier },
    { tag: t.annotation, color: syntax.modifier },
    { tag: t.modifier, color: syntax.modifier },
    { tag: t.self, color: syntax.specialVariable },
    { tag: t.namespace, color: syntax.namespace },
    { tag: t.operator, color: syntax.operator },
    { tag: t.operatorKeyword, color: syntax.keyword },
    { tag: t.url, color: syntax.url },
    { tag: t.escape, color: syntax.escape },
    { tag: t.regexp, color: syntax.regexp },
    { tag: t.link, color: syntax.link, textDecoration: "underline" },
    { tag: t.special(t.string), color: syntax.specialString },
    { tag: t.meta, color: syntax.meta },
    { tag: t.comment, color: syntax.comment },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.heading, fontWeight: "bold", color: syntax.heading },
    { tag: t.atom, color: syntax.atom },
    { tag: t.bool, color: syntax.bool },
    { tag: t.special(t.variableName), color: syntax.specialVariable },
    { tag: t.processingInstruction, color: syntax.keyword },
    { tag: t.string, color: syntax.string },
    { tag: t.inserted, color: syntax.inserted },
    { tag: t.invalid, color: syntax.invalid },
  ]);
}

export function createCodeMirrorTheme(spec: SemanticThemeSpec): Extension {
  let highlightStyle = createHighlightStyle(spec.syntax);
  return [createEditorTheme(spec), syntaxHighlighting(highlightStyle)];
}
