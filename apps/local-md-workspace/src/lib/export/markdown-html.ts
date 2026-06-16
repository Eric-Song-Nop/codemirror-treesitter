import {
  liveMdMarkdownDocumentClass,
  liveMdMarkdownDocumentCss,
  liveMdMarkdownDocumentCssVariables,
  renderMarkdownToHtml,
  type LiveMdMarkdownConfig,
} from "@codemirror-treesitter/live-md";
import { resolveMarkdownImagePath } from "@/lib/workspace/markdown-images";

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

export type MarkdownHtmlExportTheme = {
  colorScheme?: string;
  pageBackground?: string;
  variables?: Record<string, string>;
};

export type MarkdownHtmlExportOptions = {
  documentPath: string;
  markdown: string;
  markdownConfig?: LiveMdMarkdownConfig | null;
  resolveAsset?: (
    path: string,
    source: string,
  ) =>
    | MarkdownHtmlExportAsset
    | null
    | undefined
    | Promise<MarkdownHtmlExportAsset | null | undefined>;
  theme?: MarkdownHtmlExportTheme | null;
  title?: string;
};

const defaultExportTitle = "Markdown export";

export async function createStandaloneMarkdownHtml({
  documentPath,
  markdown,
  markdownConfig,
  resolveAsset,
  theme,
  title = defaultExportTitle,
}: MarkdownHtmlExportOptions): Promise<MarkdownHtmlExportResult> {
  let warnings: MarkdownHtmlExportWarning[] = [];
  let body = await renderMarkdownToHtml(markdown, {
    markdown: markdownConfig,
    resolveImageSource: async ({ source }) =>
      embedImageSource(source, {
        documentPath,
        resolveAsset,
        warnings,
      }),
  });
  return {
    html: wrapStandaloneHtml(body, { theme, title }),
    warnings,
  };
}

export function snapshotMarkdownHtmlExportTheme(element: Element | null): MarkdownHtmlExportTheme {
  if (!element || typeof getComputedStyle != "function") return {};

  let computed = getComputedStyle(element);
  let variables: Record<string, string> = {};
  for (let variable of liveMdMarkdownDocumentCssVariables) {
    let value = cssDeclarationValue(computed.getPropertyValue(variable));
    if (value) variables[variable] = value;
  }

  let pageBackground = variables["--live-md-bg"];
  return {
    colorScheme: normalizeColorScheme(computed.colorScheme) ?? colorSchemeFromColor(pageBackground),
    pageBackground,
    variables,
  };
}

function wrapStandaloneHtml(
  body: string,
  { theme, title }: { theme?: MarkdownHtmlExportTheme | null; title: string },
) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
${standaloneMarkdownHtmlShellCss(theme)}
${markdownHtmlExportThemeCss(theme)}
${liveMdMarkdownDocumentCss()}
  </style>
</head>
<body>
  <main class="${liveMdMarkdownDocumentClass}" data-live-md-document>
${body.trimEnd()}
  </main>
</body>
</html>
`;
}

async function embedImageSource(
  source: string,
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
  if (!resolveAsset) return undefined;

  let path = resolveMarkdownImagePath(source, documentPath);
  if (!path) return undefined;

  try {
    let asset = await resolveAsset(path, source);
    if (!asset) {
      warnings.push({
        kind: "image-missing",
        message: `Could not embed image ${source}.`,
        path,
        source,
      });
      return undefined;
    }

    return assetToDataUrl(asset, path);
  } catch (error) {
    warnings.push({
      kind: "image-read-error",
      message: error instanceof Error ? error.message : `Could not read image ${source}.`,
      path,
      source,
    });
    return undefined;
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

function standaloneMarkdownHtmlShellCss(theme: MarkdownHtmlExportTheme | null | undefined) {
  let colorScheme = normalizeColorScheme(theme?.colorScheme) ?? "light";
  let pageBackground =
    cssDeclarationValue(theme?.pageBackground) ??
    cssDeclarationValue(theme?.variables?.["--live-md-bg"]) ??
    "#fffdfa";
  return `html {
  color-scheme: ${colorScheme};
}

body {
  margin: 0;
  min-height: 100vh;
  background: ${pageBackground};
}`;
}

function markdownHtmlExportThemeCss(theme: MarkdownHtmlExportTheme | null | undefined) {
  let declarations = Object.entries(theme?.variables ?? {})
    .map(([property, value]) => [cssCustomPropertyName(property), cssDeclarationValue(value)])
    .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
    .map(([property, value]) => `  ${property}: ${value};`);

  if (!declarations.length) return "";
  return `.${liveMdMarkdownDocumentClass} {
${declarations.join("\n")}
}`;
}

function cssCustomPropertyName(value: string) {
  return /^--[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

function cssDeclarationValue(value: string | null | undefined) {
  let trimmed = value?.trim();
  if (!trimmed || /[;{}]/.test(trimmed)) return null;
  return trimmed;
}

function normalizeColorScheme(value: string | null | undefined) {
  let normalized = cssDeclarationValue(value);
  if (
    normalized == "dark" ||
    normalized == "light" ||
    normalized == "dark light" ||
    normalized == "light dark"
  ) {
    return normalized;
  }
  return null;
}

function colorSchemeFromColor(value: string | null | undefined) {
  let rgb = parseCssHexColor(value);
  if (!rgb) return "light";
  let relativeLuminance = (0.2126 * rgb.red + 0.7152 * rgb.green + 0.0722 * rgb.blue) / 255;
  return relativeLuminance < 0.5 ? "dark" : "light";
}

function parseCssHexColor(value: string | null | undefined) {
  let match = /^#([a-fA-F0-9]{3}|[a-fA-F0-9]{6})$/.exec(value?.trim() ?? "");
  if (!match) return null;

  let hex = match[1]!;
  if (hex.length == 3) {
    return {
      red: Number.parseInt(hex[0]! + hex[0]!, 16),
      green: Number.parseInt(hex[1]! + hex[1]!, 16),
      blue: Number.parseInt(hex[2]! + hex[2]!, 16),
    };
  }
  return {
    red: Number.parseInt(hex.slice(0, 2), 16),
    green: Number.parseInt(hex.slice(2, 4), 16),
    blue: Number.parseInt(hex.slice(4, 6), 16),
  };
}
