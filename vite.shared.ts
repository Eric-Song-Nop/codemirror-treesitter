export const workspaceAliases = {
  "@codemirror-treesitter/autocomplete": new URL(
    "packages/autocomplete/src/index.ts",
    import.meta.url,
  ).pathname,
  "@codemirror-treesitter/basic-setup": new URL("packages/codemirror/src/index.ts", import.meta.url)
    .pathname,
  "@codemirror-treesitter/commands": new URL("packages/commands/src/index.ts", import.meta.url)
    .pathname,
  "@codemirror-treesitter/language": new URL("packages/language/src/index.ts", import.meta.url)
    .pathname,
  "@codemirror-treesitter/language-data": new URL(
    "packages/language-data/src/index.ts",
    import.meta.url,
  ).pathname,
  "@codemirror-treesitter/lsp-client": new URL("packages/lsp-client/src/index.ts", import.meta.url)
    .pathname,
  "@codemirror-treesitter/merge": new URL("packages/merge/src/index.ts", import.meta.url).pathname,
  "@codemirror-treesitter/opendal-wasm-browser": new URL(
    "packages/opendal-wasm-browser/src/index.ts",
    import.meta.url,
  ).pathname,
  "@codemirror-treesitter/theme": new URL("packages/theme/src/index.ts", import.meta.url).pathname,
  "@codemirror-treesitter/theme-palettes": new URL(
    "packages/theme-palettes/src/index.ts",
    import.meta.url,
  ).pathname,
  "@codemirror-treesitter/theme-catppuccin": new URL(
    "packages/theme-catppuccin/src/index.ts",
    import.meta.url,
  ).pathname,
  "@codemirror-treesitter/theme-github": new URL(
    "packages/theme-github/src/index.ts",
    import.meta.url,
  ).pathname,
  "@codemirror-treesitter/theme-gruvbox": new URL(
    "packages/theme-gruvbox/src/index.ts",
    import.meta.url,
  ).pathname,
  "@codemirror-treesitter/live-md/fixtures": new URL(
    "packages/live-md/src/fixtures/index.ts",
    import.meta.url,
  ).pathname,
  "@codemirror-treesitter/live-md/register": new URL(
    "packages/live-md/src/register.ts",
    import.meta.url,
  ).pathname,
  "@codemirror-treesitter/live-md": new URL("packages/live-md/src/index.ts", import.meta.url)
    .pathname,
  "@codemirror-treesitter/live-md-loro": new URL(
    "packages/live-md-loro/src/index.ts",
    import.meta.url,
  ).pathname,
  "loro-codemirror": new URL("node_modules/loro-codemirror/src/index.ts", import.meta.url).pathname,
};

type WorkspaceAlias = keyof typeof workspaceAliases;

export function workspaceAliasSubset(names: WorkspaceAlias[]) {
  return Object.fromEntries(names.map((name) => [name, workspaceAliases[name]]));
}
