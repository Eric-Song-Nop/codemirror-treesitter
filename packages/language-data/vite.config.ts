import { defineConfig } from "vite-plus";
import { workspaceAliasSubset } from "../../vite.shared.ts";

export default defineConfig({
  resolve: {
    alias: workspaceAliasSubset(["@codemirror-treesitter/language"]),
  },
  pack: {
    copy: "src/wasm",
    dts: {
      tsgo: true,
    },
    exports: true,
  },
});
