import { defineConfig } from "vite-plus";
import { liveMdRawCssPlugin } from "../live-md/vite-plugin.ts";
import { workspaceAliasSubset } from "../../vite.shared.ts";

export default defineConfig({
  plugins: [liveMdRawCssPlugin()],
  resolve: {
    alias: workspaceAliasSubset(["@codemirror-treesitter/language"]),
  },
  pack: {
    copy: "src/wasm",
    plugins: [liveMdRawCssPlugin()],
    dts: {
      tsgo: true,
    },
    exports: true,
  },
});
