import { highlightTree } from "@codemirror-treesitter/language";
import { liveMdLinkMark } from "../links.js";
import { LiveMdProjectionCache } from "./cache.js";
import { LiveMdProjectionEmitter } from "./emit.js";
import type {
  LiveMdProjectionInput,
  LiveMdProjectionOutput,
  LiveMdSemanticCodeFenceUnit,
  LiveMdSemanticInput,
  LiveMdSemanticUnit,
} from "./types.js";

export { CodeFenceParseCache, LiveMdProjectionCache, WidgetCache } from "./cache.js";
export {
  LiveMdAtomicRange,
  LiveMdProjectionEmitter,
  emitAtomicParagraphGap,
  emitLineClass,
  emitMark,
  emitReplace,
  emitSyntaxVisibility,
  liveMdAtomicRange,
  liveMdParagraphGapAtomicRange,
  type LiveMdAtomicParagraphGapOptions,
  type LiveMdProjectionFinish,
  type LiveMdProjectionReplaceOptions,
  type LiveMdSyntaxVisibilityOptions,
} from "./emit.js";
export type {
  CodeFenceParseResult,
  LiveMdCacheableSemanticUnit,
  LiveMdProjectionDecoration,
  LiveMdProjectionInput,
  LiveMdProjectionOutput,
  LiveMdProjectionRange,
  LiveMdSemanticAtomicParagraphGapUnit,
  LiveMdSemanticCodeFenceUnit,
  LiveMdSemanticDocument,
  LiveMdSemanticImageUnit,
  LiveMdSemanticInput,
  LiveMdSemanticLatexUnit,
  LiveMdSemanticLineClassUnit,
  LiveMdSemanticLinkUnit,
  LiveMdSemanticListMarkerUnit,
  LiveMdSemanticMarkUnit,
  LiveMdSemanticMermaidUnit,
  LiveMdSemanticReplaceUnit,
  LiveMdSemanticSyntaxUnit,
  LiveMdSemanticTableUnit,
  LiveMdSemanticTaskMarkerUnit,
  LiveMdSemanticUnit,
  LiveMdSemanticUnitBase,
} from "./types.js";

export function projectLiveMdSemantics(
  input: LiveMdProjectionInput,
  semantic: LiveMdSemanticInput,
  cache = new LiveMdProjectionCache(),
): LiveMdProjectionOutput {
  let emitter = new LiveMdProjectionEmitter(input);
  for (let unit of semanticUnits(semantic)) {
    projectLiveMdSemanticUnit(input, unit, cache, emitter);
  }
  return emitter.finish();
}

function semanticUnits(semantic: LiveMdSemanticInput) {
  return "units" in semantic ? semantic.units : semantic;
}

function projectLiveMdSemanticUnit(
  input: LiveMdProjectionInput,
  unit: LiveMdSemanticUnit,
  cache: LiveMdProjectionCache,
  emitter: LiveMdProjectionEmitter,
) {
  switch (unit.kind) {
    case "atomicParagraphGap":
      emitter.atomicParagraphGap(unit.from, unit.to, {
        className: unit.className,
        line: unit.line,
      });
      return;
    case "codeFence":
      projectCodeFence(input, unit, cache, emitter);
      return;
    case "image":
      emitter.replace(unit.from, unit.to, cache.widgets.image(input, unit, unit.alt, unit.src), {
        atomic: unit.atomic,
        block: unit.block ?? false,
      });
      return;
    case "latex":
      emitter.replace(unit.from, unit.to, cache.widgets.latex(unit, unit.formula), {
        block: unit.formula.block,
      });
      return;
    case "lineClass":
      if (unit.line != null) emitter.lineClass(unit.line, unit.className);
      if (unit.from != null && unit.to != null) {
        emitter.lineRangeClass(unit.from, unit.to, unit.className);
      }
      return;
    case "link":
      emitter.mark(unit.from, unit.to, liveMdLinkMark(unit.destination, input.linkBaseUrl ?? null));
      return;
    case "listMarker":
      emitter.replace(unit.from, unit.to, cache.widgets.listMarker(unit, unit.marker));
      return;
    case "mark": {
      let decoration = unit.decoration ?? unit.className;
      if (decoration) emitter.mark(unit.from, unit.to, decoration);
      return;
    }
    case "mermaid":
      emitter.replace(unit.from, unit.to, cache.widgets.mermaid(unit, unit.diagram), {
        block: unit.block ?? true,
      });
      return;
    case "replace":
      emitter.replace(unit.from, unit.to, unit.widget, {
        atomic: unit.atomic,
        block: unit.block ?? false,
      });
      return;
    case "syntax":
      emitter.syntaxVisibility(unit.from, unit.to, {
        hiddenDecoration: unit.hiddenDecoration,
        visibleDecoration: unit.visibleDecoration,
      });
      return;
    case "table":
      emitter.replace(unit.from, unit.to, cache.widgets.table(unit, unit.table), { block: true });
      return;
    case "taskMarker":
      emitter.replace(unit.from, unit.to, cache.widgets.taskMarker(unit, unit.checked));
      return;
  }
}

function projectCodeFence(
  input: LiveMdProjectionInput,
  unit: LiveMdSemanticCodeFenceUnit,
  cache: LiveMdProjectionCache,
  emitter: LiveMdProjectionEmitter,
) {
  if (unit.contentFrom >= unit.contentTo) return;
  if (!rangeTouchesProjectionRanges(input, unit.contentFrom, unit.contentTo)) return;

  let parser =
    input.codeFenceLanguages.get(unit.language) ??
    input.codeFenceLanguages.get(unit.language.toLowerCase());
  if (!parser) return;

  let parse = cache.codeFences.parse(
    unit,
    parser,
    () => unit.source ?? input.state.sliceDoc(unit.contentFrom, unit.contentTo),
  );
  emitter.addCodeFenceParse(parse);

  highlightTree(
    parse.tree,
    input.codeFenceHighlighters,
    (from, to, className) => {
      splitTextRangeByLine(parse.sourceText, from, to, (rangeFrom, rangeTo) => {
        emitter.mark(unit.contentFrom + rangeFrom, unit.contentFrom + rangeTo, className);
      });
    },
    0,
    parse.sourceText.length,
  );
}

function splitTextRangeByLine(
  text: import("@codemirror/state").Text,
  from: number,
  to: number,
  visit: (from: number, to: number) => void,
) {
  let cursor = from;
  while (cursor < to) {
    let line = text.lineAt(cursor);
    let rangeTo = Math.min(to, line.to);
    if (cursor < rangeTo) visit(cursor, rangeTo);
    cursor = line.to < to ? line.to + 1 : to;
  }
}

function rangeTouchesProjectionRanges(input: LiveMdProjectionInput, from: number, to: number) {
  return input.ranges.some((range) => from < range.to && to > range.from);
}
