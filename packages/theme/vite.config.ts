import { defineConfig } from "vite-plus";
import { workspaceAliasSubset } from "../../vite.shared.ts";

export default defineConfig({
  resolve: {
    alias: workspaceAliasSubset([
      "@codemirror-treesitter/language",
      "@codemirror-treesitter/theme-palettes",
    ]),
  },
  pack: {
    dts: {
      tsgo: true,
    },
    entry: {
      index: "src/index.ts",
      catppuccin: "src/catppuccin.ts",
      github: "src/github.ts",
      gruvbox: "src/gruvbox.ts",
    },
    exports: true,
  },
});
