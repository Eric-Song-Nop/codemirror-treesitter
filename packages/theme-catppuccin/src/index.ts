import type { Extension } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror-treesitter/language";
import {
  createEditorTheme,
  createHighlightStyle,
  type SemanticThemeSpec,
} from "@codemirror-treesitter/theme";
import {
  catppuccinLatteColors,
  catppuccinMacchiatoColors,
  type CatppuccinColors,
} from "@codemirror-treesitter/theme-palettes";

export { catppuccinLatteColors, catppuccinMacchiatoColors };
export type { CatppuccinColors } from "@codemirror-treesitter/theme-palettes";

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

export const catppuccinMacchiatoThemeSpec = createCatppuccinSpec(catppuccinMacchiatoColors, "dark");
export const catppuccinMacchiatoTheme = createEditorTheme(catppuccinMacchiatoThemeSpec);
export const catppuccinMacchiatoHighlightStyle = createHighlightStyle(
  catppuccinMacchiatoThemeSpec.syntax,
);
export const catppuccinMacchiato: Extension = [
  catppuccinMacchiatoTheme,
  syntaxHighlighting(catppuccinMacchiatoHighlightStyle),
];
