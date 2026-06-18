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
  type LatexFormula,
  type MarkdownTable,
  type MermaidDiagram,
} from "../widgets.js";
import type {
  CodeFenceParseResult,
  LiveMdCacheableSemanticUnit,
  LiveMdProjectionInput,
  LiveMdSemanticCodeFenceUnit,
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
}

export type LiveMdProjectionCacheOptions = {
  readonly codeFences?: CodeFenceParseCache;
  readonly widgets?: WidgetCache;
};

export class WidgetCache {
  private readonly widgets = new Map<string, WidgetType>();

  get size() {
    return this.widgets.size;
  }

  clear() {
    this.widgets.clear();
  }

  delete(kind: LiveMdWidgetCacheKind, unit: LiveMdCacheableSemanticUnit) {
    return this.widgets.delete(liveMdWidgetCacheKey(kind, unit));
  }

  getOrCreate<T extends WidgetType>(
    kind: LiveMdWidgetCacheKind,
    unit: LiveMdCacheableSemanticUnit,
    create: () => T,
  ): T {
    let key = liveMdWidgetCacheKey(kind, unit);
    let cached = this.widgets.get(key);
    if (cached) return cached as T;
    let widget = create();
    this.widgets.set(key, widget);
    return widget;
  }

  image(input: LiveMdProjectionInput, unit: LiveMdCacheableSemanticUnit, alt: string, src: string) {
    return this.getOrCreate(
      "image",
      unit,
      () =>
        new ImagePreviewWidget(
          alt,
          resolveLiveMdImageSource(src, input.imageSourceResolver ?? null),
        ),
    );
  }

  latex(unit: LiveMdCacheableSemanticUnit, formula: LatexFormula) {
    return this.getOrCreate("latex", unit, () => new LatexWidget(formula));
  }

  listMarker(unit: LiveMdCacheableSemanticUnit, marker: string) {
    return this.getOrCreate("listMarker", unit, () => new ListMarkerWidget(marker));
  }

  mermaid(unit: LiveMdCacheableSemanticUnit, diagram: MermaidDiagram) {
    return this.getOrCreate("mermaid", unit, () => new MermaidWidget(diagram));
  }

  table(unit: LiveMdCacheableSemanticUnit, table: MarkdownTable) {
    return this.getOrCreate("table", unit, () => new TablePreviewWidget(table));
  }

  taskMarker(unit: LiveMdCacheableSemanticUnit, checked: boolean) {
    return this.getOrCreate("taskMarker", unit, () => new TaskCheckboxWidget(checked));
  }
}

export class CodeFenceParseCache {
  private nextParserId = 1;
  private readonly parserIds = new WeakMap<object, string>();
  private readonly parses = new Map<string, CodeFenceParseCacheEntry>();

  get size() {
    return this.parses.size;
  }

  clear() {
    this.parses.clear();
  }

  delete(unit: LiveMdSemanticCodeFenceUnit, parser: TreeSitterParser) {
    return this.parses.delete(this.key(unit, parser));
  }

  key(unit: LiveMdSemanticCodeFenceUnit, parser: TreeSitterParser) {
    return codeFenceParseCacheKey(unit, this.parserIdentity(parser));
  }

  parse(
    unit: LiveMdSemanticCodeFenceUnit,
    parser: TreeSitterParser,
    source: () => string,
  ): CodeFenceParseResult {
    let parserIdentity = this.parserIdentity(parser);
    let cacheKey = codeFenceParseCacheKey(unit, parserIdentity);
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

export function codeFenceParseCacheKey(unit: LiveMdSemanticCodeFenceUnit, parserIdentity: string) {
  return `codeFence:${unit.id}:${unit.signature}:${parserIdentity}`;
}

type CodeFenceParseCacheEntry = Omit<CodeFenceParseResult, "contentFrom" | "contentTo">;
