import { Marked, Renderer, type Token, type Tokens } from "marked";

export type MarkdownHtmlExportAsset =
  | ArrayBuffer
  | Blob
  | Uint8Array
  | {
      bytes: ArrayBuffer | Uint8Array;
      mediaType?: string;
    };

export type MarkdownHtmlExportWarning = {
  kind: "image-missing" | "image-read-error";
  message: string;
  path?: string;
  source: string;
};

export type MarkdownHtmlExportResult = {
  html: string;
  warnings: MarkdownHtmlExportWarning[];
};

export type MarkdownHtmlExportOptions = {
  documentPath: string;
  markdown: string;
  resolveAsset?: (
    path: string,
    source: string,
  ) =>
    | MarkdownHtmlExportAsset
    | null
    | undefined
    | Promise<MarkdownHtmlExportAsset | null | undefined>;
  title?: string;
};

const defaultExportTitle = "Markdown export";

export async function createStandaloneMarkdownHtml({
  documentPath,
  markdown,
  resolveAsset,
  title = defaultExportTitle,
}: MarkdownHtmlExportOptions): Promise<MarkdownHtmlExportResult> {
  let warnings: MarkdownHtmlExportWarning[] = [];
  let renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);

  let marked = new Marked({
    async: true,
    gfm: true,
    renderer,
    walkTokens: async (token) => {
      if (!isImageToken(token)) return;
      await embedImageToken(token, {
        documentPath,
        resolveAsset,
        warnings,
      });
    },
  });

  let body = await marked.parse(markdown);
  return {
    html: wrapStandaloneHtml(body, { title }),
    warnings,
  };
}

function isImageToken(token: Token): token is Tokens.Image {
  return token.type == "image" && "href" in token;
}

export function resolveMarkdownImagePath(source: string, documentPath: string) {
  if (!documentPath || isExternalImageSource(source)) return null;

  let path = stripImageSourceSuffix(source);
  if (!path || path.startsWith("//")) return null;

  try {
    path = decodeURI(path);
  } catch {
    return null;
  }

  return normalizeWorkspacePath(
    path.startsWith("/") ? path.slice(1) : joinWorkspacePath(directoryPath(documentPath), path),
  );
}

function wrapStandaloneHtml(body: string, { title }: { title: string }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
${standaloneMarkdownHtmlCss()}
  </style>
</head>
<body>
  <main class="markdown-document">
${body.trimEnd()}
  </main>
</body>
</html>
`;
}

async function embedImageToken(
  token: Tokens.Image,
  {
    documentPath,
    resolveAsset,
    warnings,
  }: {
    documentPath: string;
    resolveAsset: MarkdownHtmlExportOptions["resolveAsset"];
    warnings: MarkdownHtmlExportWarning[];
  },
) {
  if (!resolveAsset) return;

  let source = token.href;
  let path = resolveMarkdownImagePath(source, documentPath);
  if (!path) return;

  try {
    let asset = await resolveAsset(path, source);
    if (!asset) {
      warnings.push({
        kind: "image-missing",
        message: `Could not embed image ${source}.`,
        path,
        source,
      });
      return;
    }

    token.href = await assetToDataUrl(asset, path);
  } catch (error) {
    warnings.push({
      kind: "image-read-error",
      message: error instanceof Error ? error.message : `Could not read image ${source}.`,
      path,
      source,
    });
  }
}

async function assetToDataUrl(asset: MarkdownHtmlExportAsset, path: string) {
  let normalized = await normalizeExportAsset(asset, path);
  return `data:${normalized.mediaType};base64,${bytesToBase64(normalized.bytes)}`;
}

async function normalizeExportAsset(asset: MarkdownHtmlExportAsset, path: string) {
  if (asset instanceof Blob) {
    return {
      bytes: new Uint8Array(await asset.arrayBuffer()),
      mediaType: asset.type || mediaTypeFromPath(path),
    };
  }

  if (asset instanceof ArrayBuffer) {
    return {
      bytes: new Uint8Array(asset),
      mediaType: mediaTypeFromPath(path),
    };
  }

  if (asset instanceof Uint8Array) {
    return {
      bytes: asset,
      mediaType: mediaTypeFromPath(path),
    };
  }

  let bytes = asset.bytes instanceof ArrayBuffer ? new Uint8Array(asset.bytes) : asset.bytes;
  return {
    bytes,
    mediaType: asset.mediaType || mediaTypeFromPath(path),
  };
}

function mediaTypeFromPath(path: string) {
  let extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let chunks: string[] = [];
  let chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + chunkSize)));
  }
  return btoa(chunks.join(""));
}

function isExternalImageSource(source: string) {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source);
}

function stripImageSourceSuffix(source: string) {
  let suffixIndex = source.search(/[?#]/);
  return suffixIndex == -1 ? source : source.slice(0, suffixIndex);
}

function normalizeWorkspacePath(path: string) {
  let parts: string[] = [];
  for (let part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part == ".") continue;
    if (part == "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function directoryPath(path: string) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function joinWorkspacePath(parent: string, child: string) {
  return parent ? `${parent}/${child}` : child;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function standaloneMarkdownHtmlCss() {
  return `:root {
  color-scheme: light;
  font-family:
    ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f6f5f0;
  color: #202523;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: #f6f5f0;
}

.markdown-document {
  width: min(760px, calc(100% - 40px));
  margin: 0 auto;
  padding: 56px 0 72px;
  line-height: 1.68;
  font-size: 16px;
}

.markdown-document > :first-child {
  margin-top: 0;
}

.markdown-document > :last-child {
  margin-bottom: 0;
}

h1,
h2,
h3,
h4,
h5,
h6 {
  margin: 1.8em 0 0.65em;
  line-height: 1.18;
  color: #18201d;
}

h1 {
  padding-bottom: 0.28em;
  border-bottom: 1px solid #d9d7cc;
  font-size: 2.1rem;
}

h2 {
  font-size: 1.55rem;
}

h3 {
  font-size: 1.25rem;
}

p,
ul,
ol,
blockquote,
pre,
table,
figure {
  margin: 0 0 1.05em;
}

a {
  color: #0f766e;
  text-underline-offset: 0.18em;
}

blockquote {
  border-left: 3px solid #9aa49f;
  padding: 0.1em 0 0.1em 1em;
  color: #59645f;
}

code {
  border-radius: 4px;
  background: #e8e5da;
  padding: 0.14em 0.32em;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.92em;
}

pre {
  overflow-x: auto;
  border: 1px solid #d9d7cc;
  border-radius: 8px;
  background: #202523;
  padding: 1em;
}

pre code {
  display: block;
  border-radius: 0;
  background: transparent;
  padding: 0;
  color: #f6f5f0;
}

img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}

table {
  width: 100%;
  border-collapse: collapse;
  overflow: hidden;
}

th,
td {
  border: 1px solid #d9d7cc;
  padding: 0.55em 0.7em;
  text-align: left;
  vertical-align: top;
}

th {
  background: #e8e5da;
  font-weight: 650;
}

hr {
  border: 0;
  border-top: 1px solid #d9d7cc;
  margin: 2em 0;
}

input[type="checkbox"] {
  margin-right: 0.5em;
}

@media print {
  :root,
  body {
    background: #fff;
  }

  .markdown-document {
    width: auto;
    padding: 0;
  }

  pre,
  img,
  table {
    break-inside: avoid;
  }
}`;
}
