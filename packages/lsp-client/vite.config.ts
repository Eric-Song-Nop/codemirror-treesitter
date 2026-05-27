import { defineConfig } from "vite-plus";
import { workspaceAliasSubset } from "../../vite.shared.ts";

export default defineConfig({
  resolve: {
    alias: workspaceAliasSubset([
      "@codemirror-treesitter/autocomplete",
      "@codemirror-treesitter/language",
    ]),
  },
  pack: {
    dts: {
      tsgo: true,
    },
    exports: true,
  },
});
