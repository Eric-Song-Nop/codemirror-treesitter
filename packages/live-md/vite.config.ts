import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [rawCssTextPlugin()],
  resolve: {
    alias: {
      "@codemirror-treesitter/autocomplete": new URL(
        "../autocomplete/src/index.ts",
        import.meta.url,
      ).pathname,
      "@codemirror-treesitter/basic-setup": new URL("../codemirror/src/index.ts", import.meta.url)
        .pathname,
      "@codemirror-treesitter/commands": new URL("../commands/src/index.ts", import.meta.url)
        .pathname,
      "@codemirror-treesitter/language": new URL("../language/src/index.ts", import.meta.url)
        .pathname,
      "@codemirror-treesitter/language-data": new URL(
        "../language-data/src/index.ts",
        import.meta.url,
      ).pathname,
      "@codemirror-treesitter/theme-gruvbox": new URL(
        "../theme-gruvbox/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  pack: {
    plugins: [rawCssTextPlugin()],
    entry: {
      "fixtures/index": "src/fixtures/index.ts",
      index: "src/index.ts",
      register: "src/register.ts",
    },
    dts: {
      tsgo: true,
    },
  },
});

function rawCssTextPlugin() {
  let rawQueries = ["?raw", "?live-md-raw"];
  return {
    enforce: "pre" as const,
    name: "live-md-raw-css",
    resolveId(source: string, importer?: string) {
      let rawQuery = rawQueries.find((query) => source.endsWith(`.css${query}`));
      if (!rawQuery) return null;
      let cssSource = source.slice(0, -rawQuery.length);
      if (cssSource.startsWith("/")) return `${cssSource}${rawQuery}`;
      if (!importer) return null;
      if (!cssSource.startsWith(".")) {
        return `${createRequire(importer).resolve(cssSource)}${rawQuery}`;
      }
      return `${resolve(dirname(importer), cssSource)}${rawQuery}`;
    },
    load(id: string) {
      let rawQuery = rawQueries.find((query) => id.endsWith(`.css${query}`));
      if (!rawQuery) return null;
      let fileName = id.slice(0, -rawQuery.length);
      return `export default ${JSON.stringify(readFileSync(fileName, "utf8"))};`;
    },
  };
}
