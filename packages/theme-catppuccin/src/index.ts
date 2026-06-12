import type { Extension } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror-treesitter/language";
import { liveMdCodeFenceHighlighting } from "@codemirror-treesitter/live-md";
import {
  createEditorTheme,
  createHighlightStyle,
  type SemanticThemeSpec,
} from "@codemirror-treesitter/theme";

export const catppuccinLatteColors = {
  rosewater: "#dc8a78",
  flamingo: "#dd7878",
  pink: "#ea76cb",
  mauve: "#8839ef",
  red: "#d20f39",
  maroon: "#e64553",
  peach: "#fe640b",
  yellow: "#df8e1d",
  green: "#40a02b",
  teal: "#179299",
  sky: "#04a5e5",
  sapphire: "#209fb5",
  blue: "#1e66f5",
  lavender: "#7287fd",
  text: "#4c4f69",
  subtext1: "#5c5f77",
  subtext0: "#6c6f85",
  overlay2: "#7c7f93",
  overlay1: "#8c8fa1",
  overlay0: "#9ca0b0",
  surface2: "#acb0be",
  surface1: "#bcc0cc",
  surface0: "#ccd0da",
  base: "#eff1f5",
  mantle: "#e6e9ef",
  crust: "#dce0e8",
};

export const catppuccinMacchiatoColors = {
  rosewater: "#f4dbd6",
  flamingo: "#f0c6c6",
  pink: "#f5bde6",
  mauve: "#c6a0f6",
  red: "#ed8796",
  maroon: "#ee99a0",
  peach: "#f5a97f",
  yellow: "#eed49f",
  green: "#a6da95",
  teal: "#8bd5ca",
  sky: "#91d7e3",
  sapphire: "#7dc4e4",
  blue: "#8aadf4",
  lavender: "#b7bdf8",
  text: "#cad3f5",
  subtext1: "#b8c0e0",
  subtext0: "#a5adcb",
  overlay2: "#939ab7",
  overlay1: "#8087a2",
  overlay0: "#6e738d",
  surface2: "#5b6078",
  surface1: "#494d64",
  surface0: "#363a4f",
  base: "#24273a",
  mantle: "#1e2030",
  crust: "#181926",
};

type CatppuccinColors = typeof catppuccinLatteColors;

function createCatppuccinSpec(colors: CatppuccinColors, appearance: "dark" | "light") {
  let dark = appearance == "dark";

  return {
    appearance,
    chrome: {
      activeLine: dark ? `${colors.surface0}66` : `${colors.surface0}80`,
      background: colors.base,
      border: colors.surface1,
      cursor: colors.rosewater,
      foldPlaceholderBorder: colors.surface1,
      foldPlaceholderText: colors.subtext0,
      foreground: colors.text,
      gutterActiveBackground: dark ? colors.surface0 : colors.mantle,
      gutterActiveForeground: colors.text,
      gutterBackground: colors.base,
      gutterBorder: colors.surface0,
      gutterForeground: colors.overlay1,
      matchingBracketBackground: `${colors.green}26`,
      matchingBracketBorder: colors.green,
      nonmatchingBracketBackground: `${colors.red}26`,
      nonmatchingBracketBorder: colors.red,
      panelBackground: colors.mantle,
      panelBorder: colors.surface1,
      panelForeground: colors.text,
      searchMatch: `${colors.yellow}40`,
      searchMatchBorder: colors.yellow,
      searchMatchSelected: `${colors.peach}50`,
      selection: dark ? `${colors.surface2}80` : `${colors.surface1}cc`,
      selectionMatch: `${colors.blue}26`,
      tooltipBackground: colors.mantle,
      tooltipBorder: colors.surface1,
      tooltipForeground: colors.text,
      tooltipSelectedBackground: dark ? colors.surface1 : colors.surface0,
      tooltipSelectedForeground: colors.text,
    },
    syntax: {
      atom: colors.pink,
      bool: colors.peach,
      character: colors.teal,
      className: colors.yellow,
      comment: colors.overlay1,
      constant: colors.peach,
      definition: colors.text,
      deleted: colors.red,
      escape: colors.pink,
      functionName: colors.blue,
      heading: colors.mauve,
      inserted: colors.green,
      invalid: colors.red,
      keyword: colors.mauve,
      labelName: colors.sapphire,
      link: colors.blue,
      macroName: colors.mauve,
      meta: colors.overlay1,
      modifier: colors.maroon,
      namespace: colors.lavender,
      number: colors.peach,
      operator: colors.sky,
      propertyName: colors.sapphire,
      regexp: colors.pink,
      separator: colors.overlay2,
      specialString: colors.teal,
      specialVariable: colors.red,
      standardName: colors.text,
      string: colors.green,
      typeName: colors.yellow,
      url: colors.blue,
      variableName: colors.text,
    },
  } satisfies SemanticThemeSpec;
}

export const catppuccinLatteThemeSpec = createCatppuccinSpec(catppuccinLatteColors, "light");
export const catppuccinLatteTheme = createEditorTheme(catppuccinLatteThemeSpec);
export const catppuccinLatteHighlightStyle = createHighlightStyle(catppuccinLatteThemeSpec.syntax);
export const catppuccinLatte: Extension = [
  catppuccinLatteTheme,
  syntaxHighlighting(catppuccinLatteHighlightStyle),
];
export const catppuccinLatteLiveMdExtensions: Extension = [
  catppuccinLatte,
  liveMdCodeFenceHighlighting(catppuccinLatteHighlightStyle),
];

export const catppuccinMacchiatoThemeSpec = createCatppuccinSpec(catppuccinMacchiatoColors, "dark");
export const catppuccinMacchiatoTheme = createEditorTheme(catppuccinMacchiatoThemeSpec);
export const catppuccinMacchiatoHighlightStyle = createHighlightStyle(
  catppuccinMacchiatoThemeSpec.syntax,
);
export const catppuccinMacchiato: Extension = [
  catppuccinMacchiatoTheme,
  syntaxHighlighting(catppuccinMacchiatoHighlightStyle),
];
export const catppuccinMacchiatoLiveMdExtensions: Extension = [
  catppuccinMacchiato,
  liveMdCodeFenceHighlighting(catppuccinMacchiatoHighlightStyle),
];
