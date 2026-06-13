import { defineConfig } from "vite-plus";
import { workspaceAliasSubset } from "../../vite.shared.ts";

export default defineConfig({
  resolve: {
    alias: workspaceAliasSubset([
      "@codemirror-treesitter/live-md-theme",
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
