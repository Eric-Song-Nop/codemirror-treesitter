import { Text } from "@codemirror/state";
import {
  highlightTree,
  type Highlighter,
  type Tree,
  type TreeSitterParser,
} from "@codemirror-treesitter/language";
import { type LiveMdLeafAnalysisTrace } from "../analysis/types.js";
import {
  normalizeMarkdownImageSource,
  resolveLiveMdImageSource,
  type LiveMdImageSourceResolver,
} from "../images.js";
import { renderLatexFormula, type LatexFormula, type LatexRenderResult } from "../latex.js";
import { deleteLiveMdTree, type CodeFenceLanguageMap } from "../languages.js";
import { type MarkdownTable } from "../widgets.js";
import { type LiveMdTableModel } from "../analysis/descriptors.js";
import { hashString } from "../analysis/ranges.js";
import { liveMdObjectEpoch } from "./epochs.js";

export type LiveMdRenderCache = {
  codeFenceHighlights: Map<string, LiveMdCodeFenceHighlightResult>;
  images: Map<string, LiveMdImageRenderResult>;
  latex: Map<string, LatexRenderResult>;
  measuredHeights: Map<string, number>;
  mermaid: Map<string, LiveMdMermaidRenderHandle>;
  tables: Map<string, LiveMdTableRenderResult>;
};

export type LiveMdCodeFenceHighlightSpan = {
  className: string;
  from: number;
  to: number;
};

export type LiveMdCodeFenceHighlightResult = {
  resultKey: string;
  spans: readonly LiveMdCodeFenceHighlightSpan[];
  source: string;
};

export type LiveMdImageRenderResult = {
  height?: number;
  resultKey: string;
  src: string;
  width?: number;
};

export type LiveMdMermaidRenderResult =
  | {
      bindFunctions?: (element: Element) => void;
      ok: true;
      resultKey: string;
      svg: string;
    }
  | {
      message: string | null;
      ok: false;
      resultKey: string;
    };

export type LiveMdMermaidRenderHandle = {
  promise: Promise<LiveMdMermaidRenderResult> | null;
  result: LiveMdMermaidRenderResult | null;
  resultKey: string;
  source: string;
};

export type LiveMdMermaidRenderRequest = LiveMdMermaidRenderHandle;

export type LiveMdTableRenderResult = {
  resultKey: string;
  table: MarkdownTable;
};

const renderCacheVersion = "live-md-render-cache-v1";
const latexRendererVersion = "katex-htmlAndMathml-v1";
const tableRendererVersion = "table-dom-v1";
const imageRendererVersion = "image-resolver-v1";
const mermaidRendererVersion = "mermaid-request-result-v1";
const codeFenceRendererVersion = "code-fence-highlight-v1";
const codeFenceExactSourceKeyLimit = 16 * 1024;

export const liveMdFullQueryRenderKey = "live-md-full-query";
export const liveMdRenderCacheLimits = {
  codeFenceHighlights: 256,
  images: 256,
  latex: 256,
  measuredHeights: 512,
  mermaid: 64,
  tables: 128,
} as const;

export function createLiveMdRenderCache(): LiveMdRenderCache {
  return {
    codeFenceHighlights: new LruMap(liveMdRenderCacheLimits.codeFenceHighlights),
    images: new LruMap(liveMdRenderCacheLimits.images),
    latex: new LruMap(liveMdRenderCacheLimits.latex),
    measuredHeights: new LruMap(liveMdRenderCacheLimits.measuredHeights),
    mermaid: new LruMap(liveMdRenderCacheLimits.mermaid),
    tables: new LruMap(liveMdRenderCacheLimits.tables),
  };
}

class LruMap<Key, Value> extends Map<Key, Value> {
  constructor(private readonly maxEntries: number) {
    super();
  }

  override get(key: Key) {
    let value = super.get(key);
    if (value === undefined && !super.has(key)) return undefined;
    super.delete(key);
    super.set(key, value!);
    return value;
  }

  override set(key: Key, value: Value) {
    super.delete(key);
    while (this.size >= this.maxEntries) {
      let oldest = this.keys().next();
      if (oldest.done) break;
      super.delete(oldest.value);
    }
    super.set(key, value);
    return this;
  }
}

export function cachedLiveMdImageSource(
  cache: LiveMdRenderCache,
  trace: LiveMdLeafAnalysisTrace,
  recordRenderKey: string,
  source: string,
  resolver: LiveMdImageSourceResolver | null,
): LiveMdImageRenderResult {
  let normalized = normalizeMarkdownImageSource(source);
  let key = keyParts(
    renderCacheVersion,
    imageRendererVersion,
    recordRenderKey,
    normalized,
    resolver ? liveMdObjectEpoch(resolver) : 0,
  );
  let cached = cache.images.get(key);
  if (cached) return cached;

  trace.heavyRenderStarts++;
  let image = resolveLiveMdImageSource(source, resolver);
  let result = {
    ...image,
    resultKey: hashString(keyParts(image.src, image.width, image.height)),
  };
  cache.images.set(key, result);
  return result;
}

export function cachedLiveMdLatexResult(
  cache: LiveMdRenderCache,
  trace: LiveMdLeafAnalysisTrace,
  recordRenderKey: string,
  formula: LatexFormula,
): LatexRenderResult {
  let key = keyParts(
    renderCacheVersion,
    latexRendererVersion,
    recordRenderKey,
    formula.block ? 1 : 0,
    formula.displayMode ? 1 : 0,
    formula.source,
    formula.tex,
  );
  let cached = cache.latex.get(key);
  if (cached) return cached;

  trace.heavyRenderStarts++;
  let result = renderLatexFormula(formula);
  cache.latex.set(key, result);
  return result;
}

export function cachedLiveMdTableResult(
  cache: LiveMdRenderCache,
  trace: LiveMdLeafAnalysisTrace,
  recordRenderKey: string,
  table: LiveMdTableModel,
): LiveMdTableRenderResult {
  let key = keyParts(
    renderCacheVersion,
    tableRendererVersion,
    recordRenderKey,
    JSON.stringify(table),
  );
  let cached = cache.tables.get(key);
  if (cached) return cached;

  trace.heavyRenderStarts++;
  let rendered = markdownTable(table);
  let result = {
    resultKey: hashString(key),
    table: rendered,
  };
  cache.tables.set(key, result);
  return result;
}

export function cachedLiveMdMermaidRequest(
  cache: LiveMdRenderCache,
  trace: LiveMdLeafAnalysisTrace,
  recordRenderKey: string,
  source: string,
): LiveMdMermaidRenderRequest {
  let key = keyParts(renderCacheVersion, mermaidRendererVersion, recordRenderKey, source);
  let cached = cache.mermaid.get(key);
  if (cached) return cached;

  trace.heavyRenderStarts++;
  let result = {
    promise: null,
    result: null,
    resultKey: hashString(source),
    source,
  };
  cache.mermaid.set(key, result);
  return result;
}

export function cachedLiveMdCodeFenceHighlightResult(
  cache: LiveMdRenderCache,
  trace: LiveMdLeafAnalysisTrace,
  source: string,
  languages: CodeFenceLanguageMap,
  highlighters: readonly Highlighter[],
  recordRenderKey: string,
  language: string,
): LiveMdCodeFenceHighlightResult {
  let parser = languages.get(language);
  if (!parser || !source) return { resultKey: hashString(""), source, spans: [] };
  let sourceKey =
    source.length <= codeFenceExactSourceKeyLimit
      ? source
      : keyParts(hashString(source), source.length);

  let key = keyParts(
    renderCacheVersion,
    codeFenceRendererVersion,
    recordRenderKey,
    language,
    sourceKey,
    liveMdObjectEpoch(parser),
    highlighters.map(liveMdObjectEpoch).join(","),
  );
  let cached = cache.codeFenceHighlights.get(key);
  if (cached && cached.source == source) return cached;

  trace.heavyRenderStarts++;
  let result = parseCodeFenceHighlightSpans(trace, source, parser, highlighters);
  cache.codeFenceHighlights.set(key, result);
  return result;
}

function parseCodeFenceHighlightSpans(
  trace: LiveMdLeafAnalysisTrace,
  source: string,
  parser: CodeFenceLanguageMap extends ReadonlyMap<string, infer Parser> ? Parser : never,
  highlighters: readonly Highlighter[],
): LiveMdCodeFenceHighlightResult {
  let sourceText = Text.of(source.split("\n"));
  let nativeParser = parser.createParser();
  let nestedParsers = new Map<TreeSitterParser, ReturnType<TreeSitterParser["createParser"]>>();
  let parsed: ReturnType<typeof parser.parseWith> | null = null;
  let tree: Tree | null = null;
  let spans: LiveMdCodeFenceHighlightSpan[] = [];
  trace.codeFenceParserSessionsCreated++;
  try {
    trace.codeFenceParses++;
    parsed = parser.parseWith(nativeParser, sourceText);
    if (!parsed) return { resultKey: hashString(""), source, spans };
    tree = parser.wrapTree(parsed, sourceText, null, undefined, nestedParsers);
    if (!tree) return { resultKey: hashString(""), source, spans };
    highlightTree(
      tree,
      highlighters,
      (from, to, className) => {
        spans.push({ className, from, to });
      },
      0,
      sourceText.length,
    );
    return {
      resultKey: hashString(JSON.stringify(spans)),
      source,
      spans,
    };
  } finally {
    trace.codeFenceParserSessionsCreated += nestedParsers.size;
    let treeCount = tree ? countNativeTrees(tree) : parsed ? 1 : 0;
    trace.codeFenceTreesCreated += treeCount;
    if (tree) deleteLiveMdTree(tree);
    else parsed?.delete();
    trace.codeFenceTreesDeleted += treeCount;

    for (let nestedParser of nestedParsers.values()) {
      trace.codeFenceParserSessionsDeleted++;
      nestedParser.delete();
    }
    trace.codeFenceParserSessionsDeleted++;
    nativeParser.delete();
  }
}

function markdownTable(table: LiveMdTableModel): MarkdownTable {
  return {
    alignments: [...table.alignments],
    header: [...table.header],
    ...(table.headerCells
      ? {
          headerCells: table.headerCells.map((cell) => ({
            inline: cell.inline,
            text: cell.text,
          })),
        }
      : {}),
    rows: table.rows.map((row) => [...row]),
    ...(table.rowCells
      ? {
          rowCells: table.rowCells.map((row) =>
            row.map((cell) => ({
              inline: cell.inline,
              text: cell.text,
            })),
          ),
        }
      : {}),
  };
}

function countNativeTrees(tree: Tree): number {
  let count = tree.tree ? 1 : 0;
  for (let nested of tree.nested) {
    count += countNativeTrees(nested.tree);
  }
  return count;
}

function keyParts(...parts: readonly (boolean | number | string | null | undefined)[]) {
  return parts
    .map((part) => {
      let text = part == null ? "" : String(part);
      return `${text.length}:${text}`;
    })
    .join("|");
}
