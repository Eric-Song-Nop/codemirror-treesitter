import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, tags as t } from "@codemirror-treesitter/language";

type WorkspaceEditorColors = {
  activeLine: string;
  aqua: string;
  bg0: string;
  bg1: string;
  bg2: string;
  bg3: string;
  blue: string;
  cursor: string;
  fg0: string;
  fg1: string;
  fg2: string;
  fg3: string;
  fg4: string;
  green: string;
  heading: string;
  matchingBracket: string;
  nonmatchingBracket: string;
  orange: string;
  purple: string;
  red: string;
  search: string;
  searchSelected: string;
  selection: string;
  selectionMatch: string;
  yellow: string;
};

export const githubLightColors: WorkspaceEditorColors = {
  activeLine: "#f6f8fa",
  aqua: "#1a7f37",
  bg0: "#ffffff",
  bg1: "#f6f8fa",
  bg2: "#d0d7de",
  bg3: "#afb8c1",
  blue: "#0969da",
  cursor: "#0969da",
  fg0: "#24292f",
  fg1: "#24292f",
  fg2: "#57606a",
  fg3: "#6e7781",
  fg4: "#6e7781",
  green: "#116329",
  heading: "#24292f",
  matchingBracket: "#0969da26",
  nonmatchingBracket: "#cf222e26",
  orange: "#bc4c00",
  purple: "#8250df",
  red: "#cf222e",
  search: "#fff8c5",
  searchSelected: "#ffd33d66",
  selection: "#d0d7de",
  selectionMatch: "#0969da1f",
  yellow: "#9a6700",
};

export const catppuccinLatteColors: WorkspaceEditorColors = {
  activeLine: "#ccd0da66",
  aqua: "#179299",
  bg0: "#eff1f5",
  bg1: "#e6e9ef",
  bg2: "#ccd0da",
  bg3: "#bcc0cc",
  blue: "#1e66f5",
  cursor: "#dc8a78",
  fg0: "#4c4f69",
  fg1: "#5c5f77",
  fg2: "#6c6f85",
  fg3: "#7c7f93",
  fg4: "#8c8fa1",
  green: "#40a02b",
  heading: "#8839ef",
  matchingBracket: "#17929930",
  nonmatchingBracket: "#d20f3930",
  orange: "#fe640b",
  purple: "#8839ef",
  red: "#d20f39",
  search: "#df8e1d40",
  searchSelected: "#fe640b50",
  selection: "#ccd0da",
  selectionMatch: "#40a02b30",
  yellow: "#df8e1d",
};

export const catppuccinMacchiatoColors: WorkspaceEditorColors = {
  activeLine: "#363a4f66",
  aqua: "#8bd5ca",
  bg0: "#24273a",
  bg1: "#1e2030",
  bg2: "#363a4f",
  bg3: "#494d64",
  blue: "#8aadf4",
  cursor: "#f4dbd6",
  fg0: "#cad3f5",
  fg1: "#b8c0e0",
  fg2: "#a5adcb",
  fg3: "#939ab7",
  fg4: "#8087a2",
  green: "#a6da95",
  heading: "#c6a0f6",
  matchingBracket: "#8bd5ca30",
  nonmatchingBracket: "#ed879630",
  orange: "#f5a97f",
  purple: "#c6a0f6",
  red: "#ed8796",
  search: "#eed49f40",
  searchSelected: "#f5a97f50",
  selection: "#494d64",
  selectionMatch: "#a6da9530",
  yellow: "#eed49f",
};

function editorTheme(colors: WorkspaceEditorColors, dark: boolean) {
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
        borderLeftWidth: "2px",
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
        backgroundColor: colors.activeLine,
      },
      ".cm-selectionMatch": {
        backgroundColor: colors.selectionMatch,
      },
      "&.cm-focused .cm-matchingBracket": {
        backgroundColor: colors.matchingBracket,
        outline: `1px solid ${colors.aqua}`,
      },
      "&.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: colors.nonmatchingBracket,
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

function highlightStyle(colors: WorkspaceEditorColors) {
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
    { tag: t.heading, fontWeight: "bold", color: colors.heading },
    { tag: [t.atom, t.bool, t.special(t.variableName)], color: colors.purple },
    { tag: [t.processingInstruction, t.string, t.inserted], color: colors.green },
    { tag: t.invalid, color: colors.red },
  ]);
}

export const githubLightHighlightStyle = highlightStyle(githubLightColors);
export const githubLight: Extension = [
  editorTheme(githubLightColors, false),
  syntaxHighlighting(githubLightHighlightStyle),
];

export const catppuccinLatteHighlightStyle = highlightStyle(catppuccinLatteColors);
export const catppuccinLatte: Extension = [
  editorTheme(catppuccinLatteColors, false),
  syntaxHighlighting(catppuccinLatteHighlightStyle),
];

export const catppuccinMacchiatoHighlightStyle = highlightStyle(catppuccinMacchiatoColors);
export const catppuccinMacchiato: Extension = [
  editorTheme(catppuccinMacchiatoColors, true),
  syntaxHighlighting(catppuccinMacchiatoHighlightStyle),
];
