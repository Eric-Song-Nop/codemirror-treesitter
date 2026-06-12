import { defineConfig } from "vite-plus";
import { workspaceAliasSubset } from "../../vite.shared.ts";
import { liveMdRawCssPlugin } from "./vite-plugin.ts";

export default defineConfig({
  plugins: [liveMdRawCssPlugin()],
  resolve: {
    alias: workspaceAliasSubset([
      "@codemirror-treesitter/autocomplete",
      "@codemirror-treesitter/basic-setup",
      "@codemirror-treesitter/commands",
      "@codemirror-treesitter/language",
      "@codemirror-treesitter/language-data",
    ]),
  },
  pack: {
    deps: {
      alwaysBundle: [/^katex\/dist\//],
      onlyBundle: false,
    },
    plugins: [liveMdRawCssPlugin()],
    entry: {
      "fixtures/index": "src/fixtures/index.ts",
      index: "src/index.ts",
      register: "src/register.ts",
    },
    dts: {
      tsgo: true,
    },
  },
});
