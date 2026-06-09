import { defineConfig } from "vite-plus";
import { workspaceAliasSubset } from "../../vite.shared.ts";

export default defineConfig({
  resolve: {
    alias: workspaceAliasSubset([
      "@codemirror-treesitter/autocomplete",
      "@codemirror-treesitter/basic-setup",
      "@codemirror-treesitter/commands",
      "@codemirror-treesitter/language",
      "@codemirror-treesitter/language-data",
      "@codemirror-treesitter/live-md",
      "@codemirror-treesitter/theme-gruvbox",
      "loro-codemirror",
    ]),
  },
  pack: {
    deps: {
      alwaysBundle: [/^loro-codemirror$/],
      onlyBundle: false,
    },
    dts: {
      tsgo: true,
    },
    exports: true,
  },
});
