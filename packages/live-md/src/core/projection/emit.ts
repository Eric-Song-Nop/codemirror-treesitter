import { RangeSet, RangeSetBuilder, RangeValue, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type WidgetType } from "@codemirror/view";
import { isWhitespaceOnly, forEachLineInRange, splitRangeByLine } from "../util.js";
import { type MarkdownTable } from "../widgets.js";
import { emptyLiveMdLeafAnalysisTrace, type DocRange } from "../analysis/types.js";
import { isLiveMdInteractiveLinkDecoration } from "../links.js";
import { type LiveMdBuild, type LiveMdBuildConfig, type LiveMdEffect } from "./types.js";

export type LiveMdProjectionLayer = {
  atomicRanges: RangeSet<RangeValue>;
  decorations: DecorationSet;
  destructiveDecorations: DecorationSet;
  interactiveDecorations: DecorationSet;
  sourceSafeDecorations: DecorationSet;
};

export type LiveMdProjectionLayers = {
  atomicRanges: RangeSet<RangeValue>;
  decorations: DecorationSet;
  destructiveDecorations: DecorationSet;
  direct: LiveMdProjectionLayer;
  interactiveDecorations: DecorationSet;
  sourceSafeDecorations: DecorationSet;
  surface: LiveMdProjectionLayer;
};

const visibleSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" });
const hiddenSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-hidden" });

class AtomicRange extends RangeValue {
  eq(other: RangeValue) {
    return other instanceof AtomicRange;
  }
}

const atomicRangeValue = new AtomicRange();

export function createLiveMdBuild(config: LiveMdBuildConfig): LiveMdBuild {
  return {
    activeLines: config.activeLines,
    activeSourceRanges: config.activeSourceRanges ?? [],
    codeFenceHighlighters: config.codeFenceHighlighters,
    codeFenceLanguages: config.codeFenceLanguages,
    effects: [],
    imageSourceResolver: config.imageSourceResolver,
    linkBaseUrl: config.linkBaseUrl,
    markdownFeatures: config.markdownFeatures,
    sourceIslandMode: config.sourceIslandMode ?? false,
    state: config.state,
    trace: config.trace ?? emptyLiveMdLeafAnalysisTrace(),
    yieldCheck: config.yieldCheck,
  };
}

export function addLineClass(build: LiveMdBuild, lineNumber: number, className: string) {
  let line = build.state.doc.line(lineNumber);
  build.effects.push({ className, from: line.from, kind: "lineClass", to: line.to });
}

export function addLineRangeClass(build: LiveMdBuild, from: number, to: number, className: string) {
  forEachLineInRange(build.state, from, to, (docLine) =>
    addLineClass(build, docLine.number, className),
  );
}

export function addAtom(build: LiveMdBuild, from: number, to: number) {
  if (from < to) build.effects.push({ from, kind: "atomic", to });
}

export function addMark(build: LiveMdBuild, from: number, to: number, decoration: Decoration) {
  if (from < to) build.effects.push({ decoration, from, kind: "mark", to });
}

function forEachLineDecoration(
  build: LiveMdBuild,
  from: number,
  to: number,
  decorationForLine: (lineNumber: number) => Decoration,
  visit: (from: number, to: number, decoration: Decoration) => void,
) {
  splitRangeByLine(build.state, from, to, (lineNumber, rangeFrom, rangeTo) => {
    visit(rangeFrom, rangeTo, decorationForLine(lineNumber));
  });
}

export function addReplace(
  build: LiveMdBuild,
  from: number,
  to: number,
  widget: WidgetType,
  block = false,
  atomic = false,
) {
  if (from < to) build.effects.push({ atomic, block, from, kind: "replace", to, widget });
}

export function addSyntax(build: LiveMdBuild, from: number, to: number, decoration?: Decoration) {
  if (from < to) build.effects.push({ decoration, from, kind: "syntax", to });
}

export function finishDecorations(build: LiveMdBuild) {
  return finishDecorationSets(build).decorations;
}

export function finishDecorationSets(build: LiveMdBuild) {
  let projection = finishProjectionLayers(build);
  return {
    decorations: projection.decorations,
    destructiveDecorations: projection.destructiveDecorations,
    interactiveDecorations: projection.interactiveDecorations,
    sourceSafeDecorations: projection.sourceSafeDecorations,
  };
}

export function finishProjectionLayers(build: LiveMdBuild): LiveMdProjectionLayers {
  let lineDecorations = new RangeSetBuilder<Decoration>();
  let lineClasses = collectLineClasses(build);
  for (let [lineFrom, classes] of lineClasses) {
    lineDecorations.add(lineFrom, lineFrom, Decoration.line({ class: [...classes].join(" ") }));
  }

  let directDecorations: Array<Range<Decoration>> = [];
  let directDestructiveDecorations: Array<Range<Decoration>> = [];
  let surfaceDecorations: Array<Range<Decoration>> = [];
  let surfaceInteractiveDecorations: Array<Range<Decoration>> = [];
  let surfaceSourceSafeDecorations: Array<Range<Decoration>> = [];
  let surfaceDestructiveDecorations: Array<Range<Decoration>> = [];
  for (let effect of build.effects) {
    switch (effect.kind) {
      case "lineClass":
      case "atomic":
        break;
      case "mark":
        addProjectedDecoration(
          surfaceDecorations,
          isLiveMdInteractiveLinkDecoration(effect.decoration)
            ? surfaceInteractiveDecorations
            : surfaceSourceSafeDecorations,
          effect.decoration.range(effect.from, effect.to),
        );
        break;
      case "replace": {
        let layer = isDirectLayoutEffect(build, effect)
          ? { all: directDecorations, destructive: directDestructiveDecorations }
          : { all: surfaceDecorations, destructive: surfaceDestructiveDecorations };
        addProjectedDecoration(
          layer.all,
          layer.destructive,
          Decoration.replace({ block: effect.block ?? false, widget: effect.widget }).range(
            effect.from,
            effect.to,
          ),
        );
        break;
      }
      case "syntax":
        addSyntaxDecorations(
          build,
          surfaceDecorations,
          surfaceSourceSafeDecorations,
          surfaceDestructiveDecorations,
          effect,
        );
        break;
    }
  }
  let lineDecorationSet = lineDecorations.finish();
  let directSourceSafe = lineDecorationSet;
  let directDestructive = RangeSet.of(directDestructiveDecorations, true);
  let direct = {
    atomicRanges: finishAtomicRanges(build, "direct"),
    decorations: RangeSet.join([lineDecorationSet, RangeSet.of(directDecorations, true)]),
    destructiveDecorations: directDestructive,
    interactiveDecorations: Decoration.none,
    sourceSafeDecorations: directSourceSafe,
  };
  let surfaceInteractive = RangeSet.of(surfaceInteractiveDecorations, true);
  let surface = {
    atomicRanges: finishAtomicRanges(build, "surface"),
    decorations: RangeSet.of(surfaceDecorations, true),
    destructiveDecorations: RangeSet.of(surfaceDestructiveDecorations, true),
    interactiveDecorations: surfaceInteractive,
    sourceSafeDecorations: RangeSet.of(surfaceSourceSafeDecorations, true),
  };
  let sourceSafe = RangeSet.join([direct.sourceSafeDecorations, surface.sourceSafeDecorations]);
  let destructive = RangeSet.join([direct.destructiveDecorations, surface.destructiveDecorations]);
  return {
    atomicRanges: RangeSet.join([direct.atomicRanges, surface.atomicRanges]),
    decorations: RangeSet.join([direct.decorations, surface.decorations]),
    destructiveDecorations: destructive,
    direct,
    interactiveDecorations: surface.interactiveDecorations,
    sourceSafeDecorations: sourceSafe,
    surface,
  };
}

export function finishAtomicRanges(
  build: LiveMdBuild,
  layer: "direct" | "surface" | "all" = "all",
) {
  let builder = new RangeSetBuilder<RangeValue>();
  let atomicRanges = collectAtomicRanges(build, layer);
  for (let { from, to } of atomicRanges) {
    builder.add(from, to, atomicRangeValue);
  }
  return builder.finish();
}

function collectLineClasses(build: LiveMdBuild) {
  let lineClasses = new Map<number, Set<string>>();
  for (let effect of build.effects) {
    if (effect.kind != "lineClass") continue;
    let line = build.state.doc.lineAt(Math.min(effect.from, build.state.doc.length));
    let classes = lineClasses.get(line.from);
    if (!classes) lineClasses.set(line.from, (classes = new Set()));
    classes.add(effect.className);
  }
  return Array.from(lineClasses).sort(([leftFrom], [rightFrom]) => leftFrom - rightFrom);
}

function collectAtomicRanges(build: LiveMdBuild, layer: "direct" | "surface" | "all") {
  let atomicRanges: DocRange[] = [];
  let seen = new Set<string>();
  for (let effect of build.effects) {
    if (effect.kind == "atomic" && layer != "surface") {
      collectAtomicRange(atomicRanges, seen, effect.from, effect.to);
    }
    if (
      effect.kind == "replace" &&
      effect.atomic &&
      (layer == "all" || (isDirectLayoutEffect(build, effect) ? "direct" : "surface") == layer)
    ) {
      collectAtomicRange(atomicRanges, seen, effect.from, effect.to);
    }
  }
  return atomicRanges.sort((left, right) => left.from - right.from || left.to - right.to);
}

function collectAtomicRange(ranges: DocRange[], seen: Set<string>, from: number, to: number) {
  let key = `${from}:${to}`;
  if (seen.has(key)) return;
  seen.add(key);
  ranges.push({ from, to });
}

function addSyntaxDecorations(
  build: LiveMdBuild,
  allDecorations: Array<Range<Decoration>>,
  sourceSafeDecorations: Array<Range<Decoration>>,
  destructiveDecorations: Array<Range<Decoration>>,
  effect: Extract<LiveMdEffect, { kind: "syntax" }>,
) {
  forEachLineDecoration(
    build,
    effect.from,
    effect.to,
    (lineNumber) => {
      if (effect.decoration) return effect.decoration;
      if (rangeTouchesActiveSource(build, effect.from, effect.to)) return visibleSyntax;
      if (build.sourceIslandMode) return hiddenSyntax;
      return build.activeLines.has(lineNumber) ? visibleSyntax : hiddenSyntax;
    },
    (from, to, decoration) => {
      let target = decoration == hiddenSyntax ? destructiveDecorations : sourceSafeDecorations;
      addProjectedDecoration(allDecorations, target, decoration.range(from, to));
    },
  );
}

function addProjectedDecoration(
  allDecorations: Array<Range<Decoration>>,
  targetDecorations: Array<Range<Decoration>>,
  decoration: Range<Decoration>,
) {
  allDecorations.push(decoration);
  targetDecorations.push(decoration);
}

function isDirectLayoutEffect(build: LiveMdBuild, effect: LiveMdEffect) {
  switch (effect.kind) {
    case "lineClass":
    case "atomic":
      return true;
    case "replace":
      return Boolean(effect.block) || crossesLineBreak(build, effect.from, effect.to);
    default:
      return false;
  }
}

function crossesLineBreak(build: LiveMdBuild, from: number, to: number) {
  if (from >= to) return false;
  let firstLine = build.state.doc.lineAt(from).number;
  let lastLine = build.state.doc.lineAt(Math.max(from, to - 1)).number;
  return firstLine != lastLine;
}

export function rangeTouchesActiveLine(build: LiveMdBuild, from: number, to: number) {
  if (rangeTouchesActiveSource(build, from, to)) return true;
  if (build.sourceIslandMode) return false;
  let firstLine = build.state.doc.lineAt(from).number;
  let lastLine = build.state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber of build.activeLines) {
    if (lineNumber >= firstLine && lineNumber <= lastLine) return true;
  }
  return false;
}

export function rangeTouchesActiveSource(build: LiveMdBuild, from: number, to: number) {
  return build.activeSourceRanges.some((range) => rangesOverlap(range, from, to));
}

export function tableTouchesActiveLine(
  build: LiveMdBuild,
  from: number,
  to: number,
  table: MarkdownTable,
) {
  if (build.sourceIslandMode) return rangeTouchesActiveSource(build, from, to);
  if (rangeTouchesActiveLine(build, from, to)) return true;
  if (table.rows.length) return false;
  let end = Math.min(to, build.state.doc.length);
  let lastLine = build.state.doc.lineAt(Math.max(from, end - 1));
  let nextLineNumber = lastLine.number + 1;
  if (!build.activeLines.has(nextLineNumber) || nextLineNumber > build.state.doc.lines) {
    return false;
  }
  let nextLine = build.state.doc.line(nextLineNumber);
  return isWhitespaceOnly(build.state.sliceDoc(nextLine.from, nextLine.to));
}

function rangesOverlap(range: DocRange, from: number, to: number) {
  return range.from < to && from < range.to;
}

export function isOnlyVisibleContentOnLine(
  state: LiveMdBuild["state"],
  lineFrom: number,
  lineTo: number,
  contentFrom: number,
  contentTo: number,
) {
  return (
    isWhitespaceOnly(state.sliceDoc(lineFrom, contentFrom)) &&
    isWhitespaceOnly(state.sliceDoc(contentTo, lineTo))
  );
}
