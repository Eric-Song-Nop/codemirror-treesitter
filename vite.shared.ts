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
};

type WorkspaceAlias = keyof typeof workspaceAliases;

export function workspaceAliasSubset(names: WorkspaceAlias[]) {
  return Object.fromEntries(names.map((name) => [name, workspaceAliases[name]]));
}
