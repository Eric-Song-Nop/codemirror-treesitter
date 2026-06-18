import { Text } from "@codemirror/state";
import type { TreeSitterParser } from "@codemirror-treesitter/language";
import type { WidgetType } from "@codemirror/view";
import { resolveLiveMdImageSource } from "../images.js";
import {
  ImagePreviewWidget,
  LatexWidget,
  ListMarkerWidget,
  MermaidWidget,
  TablePreviewWidget,
  TaskCheckboxWidget,
  liveMdWidgetCacheKey,
  liveMdWidgetCacheKeyPrefix,
  type LatexFormula,
  type MarkdownTable,
  type MermaidDiagram,
} from "../widgets.js";
import type {
  CodeFenceParseResult,
  LiveMdCacheableSemanticUnit,
  LiveMdCodeFenceParseUnit,
  LiveMdProjectionInput,
} from "./types.js";

export type LiveMdWidgetCacheKind =
  | "image"
  | "latex"
  | "listMarker"
  | "mermaid"
  | "table"
  | "taskMarker";

export class LiveMdProjectionCache {
  readonly codeFences: CodeFenceParseCache;
  readonly widgets: WidgetCache;

  constructor(options: LiveMdProjectionCacheOptions = {}) {
    this.widgets = options.widgets ?? new WidgetCache();
    this.codeFences = options.codeFences ?? new CodeFenceParseCache();
  }

  clear() {
    this.widgets.clear();
    this.codeFences.clear();
  }

  beginProjection() {
    this.widgets.beginProjection();
    this.codeFences.beginProjection();
  }

  pruneUnused() {
    this.widgets.pruneUnused();
    this.codeFences.pruneUnused();
  }
}

export type LiveMdProjectionCacheOptions = {
  readonly codeFences?: CodeFenceParseCache;
  readonly widgets?: WidgetCache;
};

export class WidgetCache {
  private readonly usedKeys = new Set<string>();
  private readonly widgets = new Map<string, WidgetType>();

  get size() {
    return this.widgets.size;
  }

  clear() {
    this.usedKeys.clear();
    this.widgets.clear();
  }

  beginProjection() {
    this.usedKeys.clear();
  }

  pruneUnused() {
    for (let key of this.widgets.keys()) {
      if (!this.usedKeys.has(key)) this.widgets.delete(key);
    }
  }

  delete(kind: LiveMdWidgetCacheKind, unit: LiveMdCacheableSemanticUnit) {
    let deleted = false;
    let prefix = liveMdWidgetCacheKeyPrefix(kind, unit);
    for (let key of this.widgets.keys()) {
      if (!key.startsWith(prefix)) continue;
      deleted = this.widgets.delete(key) || deleted;
    }
    return deleted;
  }

  getOrCreate<T extends WidgetType>(
    kind: LiveMdWidgetCacheKind,
    unit: LiveMdCacheableSemanticUnit,
    context: string,
    create: () => T,
  ): T {
    let key = liveMdWidgetCacheKey(kind, unit, context);
    this.usedKeys.add(key);
    let cached = this.widgets.get(key);
    if (cached) return cached as T;
    let widget = create();
    this.widgets.set(key, widget);
    return widget;
  }

  image(input: LiveMdProjectionInput, unit: LiveMdCacheableSemanticUnit, alt: string, src: string) {
    let resolvedSrc = resolveLiveMdImageSource(src, input.imageSourceResolver ?? null);
    return this.getOrCreate(
      "image",
      unit,
      JSON.stringify([alt, resolvedSrc]),
      () => new ImagePreviewWidget(alt, resolvedSrc),
    );
  }

  latex(unit: LiveMdCacheableSemanticUnit, formula: LatexFormula) {
    return this.getOrCreate("latex", unit, JSON.stringify(formula), () => new LatexWidget(formula));
  }

  listMarker(unit: LiveMdCacheableSemanticUnit, marker: string) {
    return this.getOrCreate("listMarker", unit, marker, () => new ListMarkerWidget(marker));
  }

  mermaid(unit: LiveMdCacheableSemanticUnit, diagram: MermaidDiagram) {
    return this.getOrCreate("mermaid", unit, diagram.source, () => new MermaidWidget(diagram));
  }

  table(unit: LiveMdCacheableSemanticUnit, table: MarkdownTable) {
    return this.getOrCreate(
      "table",
      unit,
      JSON.stringify(table),
      () => new TablePreviewWidget(table),
    );
  }

  taskMarker(unit: LiveMdCacheableSemanticUnit, checked: boolean) {
    return this.getOrCreate(
      "taskMarker",
      unit,
      String(checked),
      () => new TaskCheckboxWidget(checked),
    );
  }
}

export class CodeFenceParseCache {
  private nextParserId = 1;
  private readonly parserIds = new WeakMap<object, string>();
  private readonly parses = new Map<string, CodeFenceParseCacheEntry>();
  private readonly usedKeys = new Set<string>();

  get size() {
    return this.parses.size;
  }

  clear() {
    this.usedKeys.clear();
    this.parses.clear();
  }

  beginProjection() {
    this.usedKeys.clear();
  }

  pruneUnused() {
    for (let key of this.parses.keys()) {
      if (!this.usedKeys.has(key)) this.parses.delete(key);
    }
  }

  delete(unit: LiveMdCodeFenceParseUnit, parser: TreeSitterParser) {
    return this.parses.delete(this.key(unit, parser));
  }

  key(unit: LiveMdCodeFenceParseUnit, parser: TreeSitterParser) {
    return codeFenceParseCacheKey(unit, this.parserIdentity(parser));
  }

  parse(
    unit: LiveMdCodeFenceParseUnit,
    parser: TreeSitterParser,
    source: () => string,
  ): CodeFenceParseResult {
    let parserIdentity = this.parserIdentity(parser);
    let cacheKey = codeFenceParseCacheKey(unit, parserIdentity);
    this.usedKeys.add(cacheKey);
    let cached = this.parses.get(cacheKey);
    if (!cached) {
      let sourceText = Text.of(source().split("\n"));
      cached = {
        cacheKey,
        language: unit.language,
        parser,
        parserIdentity,
        signature: unit.signature,
        sourceText,
        tree: parser.parse(sourceText),
        unitId: unit.id,
      };
      this.parses.set(cacheKey, cached);
    }

    return {
      ...cached,
      contentFrom: unit.contentFrom,
      contentTo: unit.contentTo,
      unitId: unit.id,
    };
  }

  private parserIdentity(parser: TreeSitterParser) {
    let parserObject = parser as object;
    let identity = this.parserIds.get(parserObject);
    if (!identity) {
      identity = `parser:${this.nextParserId++}`;
      this.parserIds.set(parserObject, identity);
    }
    return identity;
  }
}

export function codeFenceParseCacheKey(unit: LiveMdCodeFenceParseUnit, parserIdentity: string) {
  return `codeFence:${unit.signature}:${parserIdentity}`;
}

type CodeFenceParseCacheEntry = Omit<CodeFenceParseResult, "contentFrom" | "contentTo">;
