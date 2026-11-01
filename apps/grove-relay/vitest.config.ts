import { defineConfig } from "vite-plus";
import { workspaceAliasSubset } from "../../vite.shared.ts";

export default defineConfig({
  resolve: {
    alias: workspaceAliasSubset([
      "@codemirror-treesitter/relay-core/client",
      "@codemirror-treesitter/relay-core",
    ]),
  },
});
