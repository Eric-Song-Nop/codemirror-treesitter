import { defineConfig } from "vite-plus";
import { workspaceAliasSubset } from "../../vite.shared.ts";

export default defineConfig({
  resolve: {
    alias: {
      ...workspaceAliasSubset(["@codemirror-treesitter/live-md", "loro-codemirror"]),
    },
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
