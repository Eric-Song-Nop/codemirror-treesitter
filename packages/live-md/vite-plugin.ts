import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeCssPath = fileURLToPath(new URL("src/style.css", import.meta.url));

type RawCssPluginContext = {
  emitFile?: (file: { name: string; source: Uint8Array; type: "asset" }) => string;
};

export function liveMdRawCssPlugin() {
  let rawQueries = ["?raw", "?live-md-raw"];
  let rawExtensions = [".css", ".scm"];
  // Vite dev servers (including Vitest) cannot emit files; they serve fonts through /@fs/.
  let serve = false;
  return {
    enforce: "pre" as const,
    name: "live-md-raw-css",
    configResolved(config: { command?: string }) {
      serve = config.command == "serve";
    },
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
    load(this: RawCssPluginContext, id: string) {
      let rawImport = parseRawImport(id, rawQueries, rawExtensions);
      if (!rawImport) return null;
      let { fileName } = rawImport;
      let sourceText = readFileSync(fileName, "utf8");
      if (isRuntimeCss(fileName)) sourceText = stripKatexImport(sourceText);
      if (isKatexCss(fileName)) {
        return katexCssModule(sourceText, fileName, serve ? null : this.emitFile?.bind(this));
      }
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

/**
 * KaTeX font faces become separate woff2 assets referenced by absolute URL
 * instead of base64 data, so documents without math (or using only a few
 * faces) never download the rest. Builds emit each font as an asset; dev
 * servers reference the installed file through `/@fs/`.
 */
function katexCssModule(
  css: string,
  katexCssPath: string,
  emitFile: RawCssPluginContext["emitFile"] | null,
) {
  let fontDirectory = resolve(dirname(katexCssPath), "fonts");
  let parts: string[] = [];
  let lastIndex = 0;
  let pattern =
    /src: url\(fonts\/([^)]*\.woff2)\) format\("woff2"\), url\(fonts\/[^)]*\.woff\) format\("woff"\), url\(fonts\/[^)]*\.ttf\) format\("truetype"\);/g;
  for (let match of css.matchAll(pattern)) {
    let fontFile = match[1]!;
    let fontPath = resolve(fontDirectory, fontFile);
    let url = emitFile
      ? `import.meta.ROLLUP_FILE_URL_${emitFile({
          name: fontFile,
          source: readFileSync(fontPath),
          type: "asset",
        })}`
      : JSON.stringify(`/@fs${normalizePath(fontPath).replace(/^(?!\/)/, "/")}`);
    parts.push(JSON.stringify(css.slice(lastIndex, match.index) + "src: url("));
    parts.push(`JSON.stringify(${url})`);
    parts.push(JSON.stringify(') format("woff2");'));
    lastIndex = match.index + match[0].length;
  }
  parts.push(JSON.stringify(css.slice(lastIndex)));
  return `export default ${parts.join(" + ")};`;
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
