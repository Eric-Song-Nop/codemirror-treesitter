import {
  createLiveMdTheme,
  type LiveMdThemeColorVariables,
} from "@codemirror-treesitter/live-md-theme";
import {
  gruvboxDarkColors,
  gruvboxLightColors,
} from "@codemirror-treesitter/theme-palettes";

type GruvboxColors = typeof gruvboxDarkColors;

function gruvboxLiveMdVariables(colors: GruvboxColors): LiveMdThemeColorVariables {
  return {
    "--live-md-active-line": `color-mix(in srgb, ${colors.selection} 42%, transparent)`,
    "--live-md-accent": colors.green,
    "--live-md-accent-2": colors.orange,
    "--live-md-bg": colors.bg0,
    "--live-md-blockquote": colors.fg2,
    "--live-md-blockquote-border": colors.bg3,
    "--live-md-border": colors.bg2,
    "--live-md-code-bg": colors.bg1,
    "--live-md-code-border": colors.bg3,
    "--live-md-code-muted": colors.fg4,
    "--live-md-code-text": colors.fg1,
    "--live-md-cursor": colors.orange,
    "--live-md-error": colors.red,
    "--live-md-error-border": colors.red,
    "--live-md-heading-1": colors.yellow,
    "--live-md-heading-2": colors.green,
    "--live-md-heading-3": colors.aqua,
    "--live-md-heading-rest": colors.blue,
    "--live-md-inline-code-bg": colors.bg1,
    "--live-md-inline-code-border": colors.bg3,
    "--live-md-inline-code-text": colors.orange,
    "--live-md-latex": colors.aqua,
    "--live-md-link": colors.blue,
    "--live-md-link-underline": `color-mix(in srgb, ${colors.blue} 45%, transparent)`,
    "--live-md-list-marker": colors.green,
    "--live-md-mermaid-accent": colors.green,
    "--live-md-mermaid-bg": colors.bg0,
    "--live-md-mermaid-border": colors.bg2,
    "--live-md-mermaid-line": colors.fg4,
    "--live-md-mermaid-muted": colors.fg4,
    "--live-md-mermaid-surface": colors.bg0,
    "--live-md-mermaid-text": colors.fg1,
    "--live-md-muted": colors.fg4,
    "--live-md-ordered-marker": colors.yellow,
    "--live-md-rule": colors.bg3,
    "--live-md-selection": colors.selection,
    "--live-md-surface": colors.bg1,
    "--live-md-surface-error": `color-mix(in srgb, ${colors.red} 12%, ${colors.bg0})`,
    "--live-md-surface-error-border": colors.red,
    "--live-md-syntax": colors.fg4,
    "--live-md-table-bg": colors.bg0,
    "--live-md-table-border": colors.bg3,
    "--live-md-table-divider": colors.bg4,
    "--live-md-table-header-bg": colors.bg1,
    "--live-md-table-header-text": colors.yellow,
    "--live-md-table-line-bg": colors.bg1,
    "--live-md-table-pipe": colors.bg3,
    "--live-md-task-bg": colors.bg0,
    "--live-md-task-border": colors.bg4,
    "--live-md-task-check": colors.bg0,
    "--live-md-task-checked": colors.fg4,
    "--live-md-task-checked-strong": colors.fg3,
    "--live-md-text": colors.fg1,
  };
}

export const gruvboxDarkLiveMdTheme = createLiveMdTheme({
  appearance: "dark",
  id: "gruvbox-dark",
  variables: gruvboxLiveMdVariables(gruvboxDarkColors),
});

export const gruvboxLightLiveMdTheme = createLiveMdTheme({
  appearance: "light",
  id: "gruvbox-light",
  variables: gruvboxLiveMdVariables(gruvboxLightColors),
});
