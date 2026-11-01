import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";
import { workspaceAliasSubset } from "../../vite.shared.ts";

const { version } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
  version: string;
};
const define = { __LSP_CLIENT_VERSION__: JSON.stringify(version) };

export default defineConfig({
  define,
  resolve: {
    alias: workspaceAliasSubset([
      "@codemirror-treesitter/autocomplete",
      "@codemirror-treesitter/language",
    ]),
  },
  pack: {
    define,
    dts: {
      tsgo: true,
    },
    exports: true,
  },
});
