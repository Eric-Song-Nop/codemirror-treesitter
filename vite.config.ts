import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@codemirror-treesitter/language": new URL("packages/language/src/index.ts", import.meta.url)
        .pathname,
      "@codemirror-treesitter/language-data": new URL(
        "packages/language-data/src/index.ts",
        import.meta.url,
      ).pathname,
      "@codemirror-treesitter/commands": new URL("packages/commands/src/index.ts", import.meta.url)
        .pathname,
      "@codemirror-treesitter/autocomplete": new URL(
        "packages/autocomplete/src/index.ts",
        import.meta.url,
      ).pathname,
      "@codemirror-treesitter/merge": new URL("packages/merge/src/index.ts", import.meta.url)
        .pathname,
      "@codemirror-treesitter/lsp-client": new URL(
        "packages/lsp-client/src/index.ts",
        import.meta.url,
      ).pathname,
      "@codemirror-treesitter/basic-setup": new URL(
        "packages/codemirror/src/index.ts",
        import.meta.url,
      ).pathname,
    },
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
