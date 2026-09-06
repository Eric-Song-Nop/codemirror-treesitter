import { Text, type ChangeDesc } from "@codemirror/state";
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
import { LiveMdCodeFenceSession } from "./code-fence-session.js";
import { type DocRange, emptyLiveMdLeafAnalysisTrace } from "../analysis/types.js";

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
  range?: DocRange,
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

  let owner = codeFenceSessionOwners.get(cache);
  if (owner && range) {
    let request = owner.requests.get(range.from);
    if (!request || request.key != key || request.source != source) {
      request = { key, source, parser, highlighters, range, trace };
      owner.requests.set(range.from, request);
    }
    let session = admitCodeFenceRequest(owner, request);
    if (session) {
      session.work(() => performance.now() >= owner.deadline);
      if (session.result) {
        cache.codeFenceHighlights.set(key, session.result);
        owner.requests.delete(range.from);
        return session.result;
      }
    }
    scheduleCodeFenceSessions(owner);
    return { resultKey: hashString(""), source, spans: [] };
  }

  trace.heavyRenderStarts++;
  let result = parseCodeFenceHighlightSpans(trace, source, parser, highlighters);
  cache.codeFenceHighlights.set(key, result);
  return result;
}

type CodeFenceRequest = {
  key: string;
  source: string;
  parser: TreeSitterParser;
  highlighters: readonly Highlighter[];
  range: DocRange;
  trace: LiveMdLeafAnalysisTrace;
};

const codeFenceNativeSessionLimit = 16;

type CodeFenceSessionOwner = {
  cache: LiveMdRenderCache;
  // Coalesced metadata only: at most one request per current surface fence.
  // Pending native sessions are never evicted to admit a later request.
  requests: Map<number, CodeFenceRequest>;
  sessions: Map<number, LiveMdCodeFenceSession>;
  callback: (ranges: readonly DocRange[], trace: LiveMdLeafAnalysisTrace) => void;
  asyncTrace: LiveMdLeafAnalysisTrace;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number;
};
const codeFenceSessionOwners = new WeakMap<LiveMdRenderCache, CodeFenceSessionOwner>();

export function connectLiveMdCodeFenceSessions(
  cache: LiveMdRenderCache,
  callback: CodeFenceSessionOwner["callback"],
) {
  let previous = codeFenceSessionOwners.get(cache);
  if (previous) {
    previous.callback = callback;
    return;
  }
  codeFenceSessionOwners.set(cache, {
    cache,
    requests: new Map(),
    sessions: new Map(),
    asyncTrace: emptyLiveMdLeafAnalysisTrace(),
    callback,
    timer: null,
    deadline: performance.now() + 4,
  });
}

export function disposeLiveMdCodeFenceSessions(cache: LiveMdRenderCache) {
  let owner = codeFenceSessionOwners.get(cache);
  if (!owner) return;
  if (owner.timer != null) clearTimeout(owner.timer);
  for (let session of owner.sessions.values()) session.dispose();
  owner.sessions.clear();
  owner.requests.clear();
  codeFenceSessionOwners.delete(cache);
}

export function mapLiveMdCodeFenceSessions(cache: LiveMdRenderCache, changes: ChangeDesc) {
  let owner = codeFenceSessionOwners.get(cache);
  if (!owner || changes.empty) return;
  let mapped = new Map<number, LiveMdCodeFenceSession>();
  for (let session of owner.sessions.values()) {
    let removed = false;
    changes.iterChangedRanges((from, to) => {
      if (from <= session.range.from && to >= session.range.to) removed = true;
    });
    if (removed) {
      session.dispose();
      continue;
    }
    session.map(changes);
    mapped.get(session.range.from)?.dispose();
    mapped.set(session.range.from, session);
  }
  owner.sessions = mapped;
  let requests = new Map<number, CodeFenceRequest>();
  for (let request of owner.requests.values()) {
    // Changed requests must be rediscovered from the next committed semantics.
    if (changes.touchesRange(request.range.from, request.range.to)) continue;
    let range = {
      from: changes.mapPos(request.range.from, -1),
      to: changes.mapPos(request.range.to, 1),
    };
    requests.set(range.from, { ...request, range });
  }
  owner.requests = requests;
  owner.deadline = performance.now() + 4;
}

/** Drop resources for fences removed or no longer selected for the visible surface. */
export function pruneLiveMdCodeFenceSessions(
  cache: LiveMdRenderCache,
  ranges: readonly DocRange[],
  tree?: Tree,
) {
  let owner = codeFenceSessionOwners.get(cache);
  if (!owner) return;
  let retain = (range: DocRange) => {
    let node = tree?.resolve(range.from, 1);
    while (node && node.name != "fenced_code_block") node = node.parent ?? undefined;
    return (
      (!tree || node) &&
      ranges.some((visible) => visible.from <= range.to && visible.to >= range.from)
    );
  };
  for (let [position, session] of owner.sessions) {
    if (retain(session.range)) continue;
    session.dispose();
    owner.sessions.delete(position);
  }
  for (let [position, request] of owner.requests) {
    if (!retain(request.range)) owner.requests.delete(position);
  }
}

export function liveMdCodeFenceSessionsPending(cache: LiveMdRenderCache) {
  return !!codeFenceSessionOwners.get(cache)?.requests.size;
}

function admitCodeFenceRequest(owner: CodeFenceSessionOwner, request: CodeFenceRequest) {
  let position = request.range.from;
  let session = owner.sessions.get(position);
  if (session && session.parser != request.parser) {
    session.dispose();
    owner.sessions.delete(position);
    session = undefined;
  }
  if (!session) {
    if (owner.sessions.size >= codeFenceNativeSessionLimit) {
      let reusable = Array.from(owner.sessions).find(([, candidate]) => !candidate.pending);
      if (!reusable) return null;
      reusable[1].dispose();
      owner.sessions.delete(reusable[0]);
    }
    session = new LiveMdCodeFenceSession(request.parser, request.range, request.trace);
    owner.sessions.set(position, session);
  }
  session.range = request.range;
  session.request(request.source, request.key, request.highlighters, request.trace);
  return session;
}

function scheduleCodeFenceSessions(owner: CodeFenceSessionOwner) {
  if (owner.timer != null) return;
  owner.timer = setTimeout(() => {
    owner.timer = null;
    owner.deadline = performance.now() + 6;
    let completed: DocRange[] = [];
    // FIFO admission also covers requests that have no native session yet.
    for (let [position, request] of Array.from(owner.requests)) {
      if (performance.now() >= owner.deadline) break;
      let before = { ...request.trace };
      let session = admitCodeFenceRequest(owner, request);
      if (!session) continue;
      let done = session.work(() => performance.now() >= owner.deadline);
      for (let key of [
        "heavyRenderStarts",
        "codeFenceParses",
        "codeFenceParserSessionsCreated",
        "codeFenceParserSessionsDeleted",
        "codeFenceTreesCreated",
        "codeFenceTreesDeleted",
      ] as const) {
        owner.asyncTrace[key] += request.trace[key] - before[key];
      }
      if (done && session.result) {
        // Publish into the result cache before another request can evict this
        // completed native session and before the surface refresh callback.
        owner.cache.codeFenceHighlights.set(request.key, session.result);
        owner.requests.delete(position);
        completed.push(session.range);
      } else {
        // Rotate unfinished work behind its peers. One large fence must not
        // consume every turn while shorter visible fences wait indefinitely.
        owner.requests.delete(position);
        owner.requests.set(position, request);
      }
    }
    if (completed.length) {
      let trace = owner.asyncTrace;
      owner.asyncTrace = emptyLiveMdLeafAnalysisTrace();
      owner.callback(completed, trace);
    }
    if (owner.requests.size) scheduleCodeFenceSessions(owner);
  }, 0);
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
  let count = 0;
  let pending = [tree];
  let visited = new Set<Tree>();
  while (pending.length) {
    let current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (current.tree) count++;
    for (let nested of current.nested) pending.push(nested.tree);
  }
  return count;
}

export function __testCountNativeTrees(tree: Tree) {
  return countNativeTrees(tree);
}

function keyParts(...parts: readonly (boolean | number | string | null | undefined)[]) {
  return parts
    .map((part) => {
      let text = part == null ? "" : String(part);
      return `${text.length}:${text}`;
    })
    .join("|");
}
