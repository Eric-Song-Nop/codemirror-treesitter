import { defineConfig } from "vite-plus";

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
  "@codemirror-treesitter/typora-runtime/fixtures": new URL(
    "packages/typora-runtime/src/fixtures/index.ts",
    import.meta.url,
  ).pathname,
  "@codemirror-treesitter/typora-runtime/register": new URL(
    "packages/typora-runtime/src/register.ts",
    import.meta.url,
  ).pathname,
  "@codemirror-treesitter/typora-runtime": new URL(
    "packages/typora-runtime/src/index.ts",
    import.meta.url,
  ).pathname,
};

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
