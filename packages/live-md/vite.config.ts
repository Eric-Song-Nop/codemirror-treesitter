import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const runtimeCssPath = fileURLToPath(new URL("src/style.css", import.meta.url));

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
    deps: {
      alwaysBundle: [/^katex\/dist\//],
      onlyBundle: false,
    },
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
      let css = readFileSync(fileName, "utf8");
      if (isRuntimeCss(fileName)) css = stripKatexImport(css);
      if (isKatexCss(fileName)) css = inlineKatexFontData(css, fileName);
      return `export default ${JSON.stringify(css)};`;
    },
  };
}

function inlineKatexFontData(css: string, katexCssPath: string) {
  let fontDirectory = resolve(dirname(katexCssPath), "fonts");
  return css.replace(
    /src: url\(fonts\/([^)]*\.woff2)\) format\("woff2"\), url\(fonts\/[^)]*\.woff\) format\("woff"\), url\(fonts\/[^)]*\.ttf\) format\("truetype"\);/g,
    (_match, fileName: string) => {
      let fontData = readFileSync(resolve(fontDirectory, fileName), "base64");
      return `src: url(${JSON.stringify(`data:font/woff2;base64,${fontData}`)}) format("woff2");`;
    },
  );
}

function isKatexCss(fileName: string) {
  return normalizePath(fileName).endsWith("/katex/dist/katex.css");
}

function isRuntimeCss(fileName: string) {
  return normalizePath(fileName) == normalizePath(runtimeCssPath);
}

function stripKatexImport(css: string) {
  return css.replace(/^\s*@import\s+(?:url\()?["']katex\/dist\/katex\.css["']\)?;\s*/u, "");
}

function normalizePath(fileName: string) {
  return fileName.split("\\").join("/");
}
