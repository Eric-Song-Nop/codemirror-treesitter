import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, tags as t } from "@codemirror-treesitter/language";

export const gruvboxDarkColors = {
  bg0: "#282828",
  bg1: "#3c3836",
  bg2: "#504945",
  bg3: "#665c54",
  bg4: "#7c6f64",
  fg0: "#fbf1c7",
  fg1: "#ebdbb2",
  fg2: "#d5c4a1",
  fg3: "#bdae93",
  fg4: "#a89984",
  red: "#fb4934",
  green: "#b8bb26",
  yellow: "#fabd2f",
  blue: "#83a598",
  purple: "#d3869b",
  aqua: "#8ec07c",
  orange: "#fe8019",
  selection: "#504945",
  cursor: "#fe8019",
  search: "#fabd2f40",
  searchSelected: "#fe801950",
};

export const gruvboxLightColors = {
  bg0: "#fbf1c7",
  bg1: "#ebdbb2",
  bg2: "#d5c4a1",
  bg3: "#bdae93",
  bg4: "#a89984",
  fg0: "#282828",
  fg1: "#3c3836",
  fg2: "#504945",
  fg3: "#665c54",
  fg4: "#7c6f64",
  red: "#9d0006",
  green: "#79740e",
  yellow: "#b57614",
  blue: "#076678",
  purple: "#8f3f71",
  aqua: "#427b58",
  orange: "#af3a03",
  selection: "#d5c4a1",
  cursor: "#af3a03",
  search: "#d7992140",
  searchSelected: "#af3a0350",
};

type GruvboxColors = typeof gruvboxDarkColors;

function editorTheme(colors: GruvboxColors, dark: boolean) {
  return EditorView.theme(
    {
      "&": {
        color: colors.fg1,
        backgroundColor: colors.bg0,
      },
      ".cm-content": {
        caretColor: colors.cursor,
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: colors.cursor,
      },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: colors.selection,
        },
      ".cm-panels": {
        backgroundColor: colors.bg1,
        color: colors.fg1,
      },
      ".cm-panels.cm-panels-top": {
        borderBottom: `1px solid ${colors.bg3}`,
      },
      ".cm-panels.cm-panels-bottom": {
        borderTop: `1px solid ${colors.bg3}`,
      },
      ".cm-searchMatch": {
        backgroundColor: colors.search,
        outline: `1px solid ${colors.yellow}`,
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: colors.searchSelected,
      },
      ".cm-activeLine": {
        backgroundColor: dark ? "#ffffff0a" : "#3c38360a",
      },
      ".cm-selectionMatch": {
        backgroundColor: dark ? "#b8bb2630" : "#79740e30",
      },
      "&.cm-focused .cm-matchingBracket": {
        backgroundColor: dark ? "#8ec07c30" : "#427b5830",
        outline: `1px solid ${colors.aqua}`,
      },
      "&.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: dark ? "#fb493430" : "#9d000630",
        outline: `1px solid ${colors.red}`,
      },
      ".cm-gutters": {
        backgroundColor: colors.bg0,
        color: colors.fg4,
        borderRight: `1px solid ${colors.bg2}`,
      },
      ".cm-activeLineGutter": {
        backgroundColor: colors.bg1,
        color: colors.fg2,
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: `1px solid ${colors.bg3}`,
        color: colors.fg3,
      },
      ".cm-tooltip": {
        border: `1px solid ${colors.bg3}`,
        backgroundColor: colors.bg1,
        color: colors.fg1,
      },
      ".cm-tooltip .cm-tooltip-arrow:before": {
        borderTopColor: colors.bg3,
        borderBottomColor: colors.bg3,
      },
      ".cm-tooltip .cm-tooltip-arrow:after": {
        borderTopColor: colors.bg1,
        borderBottomColor: colors.bg1,
      },
      ".cm-tooltip-autocomplete": {
        "& > ul > li[aria-selected]": {
          backgroundColor: colors.bg2,
          color: colors.fg0,
        },
      },
    },
    { dark },
  );
}

function highlightStyle(colors: GruvboxColors) {
  return HighlightStyle.define([
    { tag: t.keyword, color: colors.red },
    { tag: [t.name, t.deleted, t.character, t.macroName], color: colors.red },
    { tag: [t.propertyName, t.attributeName], color: colors.blue },
    { tag: [t.function(t.variableName), t.labelName], color: colors.blue },
    { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: colors.orange },
    { tag: [t.definition(t.name), t.separator], color: colors.fg1 },
    {
      tag: [
        t.typeName,
        t.className,
        t.number,
        t.changed,
        t.annotation,
        t.modifier,
        t.self,
        t.namespace,
      ],
      color: colors.yellow,
    },
    {
      tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)],
      color: colors.aqua,
    },
    { tag: [t.meta, t.comment], color: colors.fg4 },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.link, color: colors.aqua, textDecoration: "underline" },
    { tag: t.heading, fontWeight: "bold", color: colors.orange },
    { tag: [t.atom, t.bool, t.special(t.variableName)], color: colors.purple },
    { tag: [t.processingInstruction, t.string, t.inserted], color: colors.green },
    { tag: t.invalid, color: colors.red },
  ]);
}

export const gruvboxDarkTheme = editorTheme(gruvboxDarkColors, true);
export const gruvboxDarkHighlightStyle = highlightStyle(gruvboxDarkColors);
export const gruvboxDark: Extension = [
  gruvboxDarkTheme,
  syntaxHighlighting(gruvboxDarkHighlightStyle),
];

export const gruvboxLightTheme = editorTheme(gruvboxLightColors, false);
export const gruvboxLightHighlightStyle = highlightStyle(gruvboxLightColors);
export const gruvboxLight: Extension = [
  gruvboxLightTheme,
  syntaxHighlighting(gruvboxLightHighlightStyle),
];
