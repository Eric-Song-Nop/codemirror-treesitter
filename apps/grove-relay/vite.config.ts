import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";
import { workspaceAliasSubset } from "../../vite.shared.ts";

export default defineConfig({
  plugins: [cloudflare()],
  resolve: {
    alias: workspaceAliasSubset([
      "@codemirror-treesitter/relay-core/client",
      "@codemirror-treesitter/relay-core",
    ]),
  },
});
