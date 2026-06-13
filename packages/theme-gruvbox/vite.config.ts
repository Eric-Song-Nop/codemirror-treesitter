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
      "@codemirror-treesitter/theme",
      "@codemirror-treesitter/theme-palettes",
    ]),
  },
  pack: {
    dts: {
      tsgo: true,
    },
    exports: true,
  },
});
