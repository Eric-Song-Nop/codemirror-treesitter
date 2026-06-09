import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeCssPath = fileURLToPath(new URL("src/style.css", import.meta.url));

export function liveMdRawCssPlugin() {
  let rawQueries = ["?raw", "?live-md-raw"];
  let rawExtensions = [".css", ".scm"];
  return {
    enforce: "pre" as const,
    name: "live-md-raw-css",
    resolveId(source: string, importer?: string) {
      let rawImport = parseRawImport(source, rawQueries, rawExtensions);
      if (!rawImport) return null;
      if (rawImport.fileName.startsWith("/")) return `${rawImport.fileName}${rawImport.query}`;
      if (!importer) return null;
      if (!rawImport.fileName.startsWith(".")) {
        return `${createRequire(importer).resolve(rawImport.fileName)}${rawImport.query}`;
      }
      return `${resolve(dirname(importer), rawImport.fileName)}${rawImport.query}`;
    },
    load(id: string) {
      let rawImport = parseRawImport(id, rawQueries, rawExtensions);
      if (!rawImport) return null;
      let { fileName } = rawImport;
      let sourceText = readFileSync(fileName, "utf8");
      if (isRuntimeCss(fileName)) sourceText = stripKatexImport(sourceText);
      if (isKatexCss(fileName)) sourceText = inlineKatexFontData(sourceText, fileName);
      return `export default ${JSON.stringify(sourceText)};`;
    },
  };
}

function parseRawImport(source: string, queries: readonly string[], extensions: readonly string[]) {
  let query = queries.find((candidate) => source.endsWith(candidate));
  if (!query) return null;
  let fileName = source.slice(0, -query.length);
  if (!extensions.some((extension) => fileName.endsWith(extension))) return null;
  return { fileName, query };
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
