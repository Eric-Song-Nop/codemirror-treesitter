import type { Extension } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror-treesitter/language";
import { liveMdCodeFenceHighlighting } from "@codemirror-treesitter/live-md";
import {
  createEditorTheme,
  createHighlightStyle,
  type SemanticThemeSpec,
} from "@codemirror-treesitter/theme";

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

function gruvboxThemeSpec(
  colors: GruvboxColors,
  appearance: SemanticThemeSpec["appearance"],
): SemanticThemeSpec {
  let dark = appearance == "dark";

  return {
    appearance,
    chrome: {
      activeLine: dark ? "#ffffff0a" : "#3c38360a",
      background: colors.bg0,
      border: colors.bg3,
      cursor: colors.cursor,
      foldPlaceholderBorder: colors.bg3,
      foldPlaceholderText: colors.fg3,
      foreground: colors.fg1,
      gutterActiveBackground: colors.bg1,
      gutterActiveForeground: colors.fg2,
      gutterBackground: colors.bg0,
      gutterBorder: colors.bg2,
      gutterForeground: colors.fg4,
      matchingBracketBackground: dark ? "#8ec07c30" : "#427b5830",
      matchingBracketBorder: colors.aqua,
      nonmatchingBracketBackground: dark ? "#fb493430" : "#9d000630",
      nonmatchingBracketBorder: colors.red,
      panelBackground: colors.bg1,
      panelBorder: colors.bg3,
      panelForeground: colors.fg1,
      searchMatch: colors.search,
      searchMatchBorder: colors.yellow,
      searchMatchSelected: colors.searchSelected,
      selection: colors.selection,
      selectionMatch: dark ? "#b8bb2630" : "#79740e30",
      tooltipBackground: colors.bg1,
      tooltipBorder: colors.bg3,
      tooltipForeground: colors.fg1,
      tooltipSelectedBackground: colors.bg2,
      tooltipSelectedForeground: colors.fg0,
    },
    syntax: {
      atom: colors.purple,
      bool: colors.purple,
      character: colors.red,
      className: colors.yellow,
      comment: colors.fg4,
      constant: colors.orange,
      definition: colors.fg1,
      deleted: colors.red,
      escape: colors.aqua,
      functionName: colors.blue,
      heading: colors.orange,
      inserted: colors.green,
      invalid: colors.red,
      keyword: colors.red,
      labelName: colors.blue,
      link: colors.aqua,
      macroName: colors.red,
      meta: colors.fg4,
      modifier: colors.yellow,
      namespace: colors.yellow,
      number: colors.yellow,
      operator: colors.aqua,
      propertyName: colors.blue,
      regexp: colors.aqua,
      separator: colors.fg1,
      specialString: colors.aqua,
      specialVariable: colors.purple,
      standardName: colors.orange,
      string: colors.green,
      typeName: colors.yellow,
      url: colors.aqua,
      variableName: colors.red,
    },
  };
}

export const gruvboxDarkThemeSpec = gruvboxThemeSpec(gruvboxDarkColors, "dark");
export const gruvboxLightThemeSpec = gruvboxThemeSpec(gruvboxLightColors, "light");
export const gruvboxDarkSpec = gruvboxDarkThemeSpec;
export const gruvboxLightSpec = gruvboxLightThemeSpec;

export const gruvboxDarkTheme = createEditorTheme(gruvboxDarkThemeSpec);
export const gruvboxDarkHighlightStyle = createHighlightStyle(gruvboxDarkThemeSpec.syntax);
export const gruvboxDark: Extension = [
  gruvboxDarkTheme,
  syntaxHighlighting(gruvboxDarkHighlightStyle),
];
export const gruvboxDarkLiveMdExtensions: Extension = [
  gruvboxDark,
  liveMdCodeFenceHighlighting(gruvboxDarkHighlightStyle),
];

export const gruvboxLightTheme = createEditorTheme(gruvboxLightThemeSpec);
export const gruvboxLightHighlightStyle = createHighlightStyle(gruvboxLightThemeSpec.syntax);
export const gruvboxLight: Extension = [
  gruvboxLightTheme,
  syntaxHighlighting(gruvboxLightHighlightStyle),
];
export const gruvboxLightLiveMdExtensions: Extension = [
  gruvboxLight,
  liveMdCodeFenceHighlighting(gruvboxLightHighlightStyle),
];
