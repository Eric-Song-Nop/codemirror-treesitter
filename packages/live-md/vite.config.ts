import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
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
  return {
    name: "live-md-raw-css",
    resolveId(source: string, importer?: string) {
      if (!source.endsWith(".css?raw")) return null;
      let cssSource = source.slice(0, -"?raw".length);
      if (cssSource.startsWith("/")) return `${cssSource}?raw`;
      if (!importer) return null;
      return `${resolve(dirname(importer), cssSource)}?raw`;
    },
    load(id: string) {
      if (!id.endsWith(".css?raw")) return null;
      let fileName = id.slice(0, -"?raw".length);
      return `export default ${JSON.stringify(readFileSync(fileName, "utf8"))};`;
    },
  };
}
