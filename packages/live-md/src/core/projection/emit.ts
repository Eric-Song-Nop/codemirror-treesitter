import { RangeSet, RangeSetBuilder, RangeValue, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type WidgetType } from "@codemirror/view";
import { isWhitespaceOnly, forEachLineInRange, splitRangeByLine } from "../util.js";
import { type MarkdownTable } from "../widgets.js";
import { defaultLiveMdRenderKeyContext } from "../analysis/markdown-leaf-analysis.js";
import { rangesOverlap } from "../analysis/ranges.js";
import { emptyLiveMdLeafAnalysisTrace, type DocRange } from "../analysis/types.js";
import { isLiveMdInteractiveLinkDecoration } from "../links.js";
import { createLiveMdRenderCache } from "../runtime/render-cache.js";
import {
  type LiveMdBuild,
  type LiveMdBuildConfig,
  type LiveMdEffect,
  type LiveMdEffectOwnerKey,
} from "./types.js";

export type LiveMdProjectionLayer = {
  atomicRanges: RangeSet<RangeValue>;
  decorations: DecorationSet;
  destructiveDecorations: DecorationSet;
  interactiveDecorations: DecorationSet;
  sourceSafeDecorations: DecorationSet;
  structuralLineDecorations: DecorationSet;
};

export type LiveMdProjectionLayers = {
  atomicRanges: RangeSet<RangeValue>;
  decorations: DecorationSet;
  destructiveDecorations: DecorationSet;
  direct: LiveMdProjectionLayer;
  interactiveDecorations: DecorationSet;
  sourceSafeDecorations: DecorationSet;
  structuralLineDecorations: DecorationSet;
  surface: LiveMdProjectionLayer;
};

const visibleSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" });
const hiddenSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-hidden" });
const projectionOwnerKeys = Symbol("liveMdProjectionOwnerKeys");
const projectionReplacementBoundary = Symbol("liveMdProjectionReplacementBoundary");

class AtomicRange extends RangeValue {
  constructor(
    readonly ownerKeys: readonly LiveMdEffectOwnerKey[] = [],
    readonly replacementBoundary = false,
  ) {
    super();
    if (replacementBoundary) {
      // Keep insertions at either edge outside a replacement-owned atomic
      // range, matching the exact mapping of its replacement decoration.
      this.startSide = 1;
      this.endSide = -1;
    }
  }

  eq(other: RangeValue) {
    return (
      other instanceof AtomicRange &&
      other.replacementBoundary == this.replacementBoundary &&
      sameArrayItems(this.ownerKeys, other.ownerKeys)
    );
  }
}

const atomicRangeValue = new AtomicRange();
const replacementAtomicRangeValue = new AtomicRange([], true);

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
    renderKeyContext: config.renderKeyContext ?? defaultLiveMdRenderKeyContext,
    renderCache: config.renderCache ?? createLiveMdRenderCache(),
    sourceIslandMode: config.sourceIslandMode ?? false,
    state: config.state,
    trace: config.trace ?? emptyLiveMdLeafAnalysisTrace(),
    yieldCheck: config.yieldCheck,
  };
}

export function addLineClass(
  build: LiveMdBuild,
  lineNumber: number,
  className: string,
  ownerKeys?: readonly LiveMdEffectOwnerKey[],
) {
  let line = build.state.doc.line(lineNumber);
  build.effects.push({ className, from: line.from, kind: "lineClass", ownerKeys, to: line.to });
}

export function addLineRangeClass(
  build: LiveMdBuild,
  from: number,
  to: number,
  className: string,
  ownerKeys?: readonly LiveMdEffectOwnerKey[],
) {
  forEachLineInRange(build.state, from, to, (docLine) =>
    addLineClass(build, docLine.number, className, ownerKeys),
  );
}

export function addAtom(
  build: LiveMdBuild,
  from: number,
  to: number,
  ownerKeys?: readonly LiveMdEffectOwnerKey[],
) {
  if (from < to) build.effects.push({ from, kind: "atomic", ownerKeys, to });
}

export function addMark(
  build: LiveMdBuild,
  from: number,
  to: number,
  decoration: Decoration,
  ownerKeys?: readonly LiveMdEffectOwnerKey[],
) {
  if (from < to) build.effects.push({ decoration, from, kind: "mark", ownerKeys, to });
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
  ownerKeys?: readonly LiveMdEffectOwnerKey[],
) {
  if (from < to) {
    build.effects.push({ atomic, block, from, kind: "replace", ownerKeys, to, widget });
  }
}

export function addSyntax(
  build: LiveMdBuild,
  from: number,
  to: number,
  decoration?: Decoration,
  ownerKeys?: readonly LiveMdEffectOwnerKey[],
) {
  if (from < to) build.effects.push({ decoration, from, kind: "syntax", ownerKeys, to });
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
  for (let line of lineClasses) {
    lineDecorations.add(
      line.from,
      line.from,
      Decoration.line(
        withProjectionOwnerKeys({ class: [...line.classes].join(" ") }, line.ownerKeys),
      ),
    );
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
          Decoration.replace(
            withProjectionOwnerKeys(
              withProjectionReplacementBoundary({
                block: effect.block ?? false,
                // CodeMirror uses inclusive block sides to avoid creating
                // phantom text lines around a block widget. LiveMD maps the
                // exact replacement boundary itself in mapProjectionSets.
                inclusiveEnd: effect.block ?? false,
                inclusiveStart: effect.block ?? false,
                widget: effect.widget,
              }),
              effect.ownerKeys,
            ),
          ).range(effect.from, effect.to),
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
  let directStructuralLineDecorations = lineDecorationSet;
  let directDestructive = RangeSet.of(directDestructiveDecorations, true);
  let direct = {
    atomicRanges: finishAtomicRanges(build, "direct"),
    decorations: RangeSet.join([
      directStructuralLineDecorations,
      RangeSet.of(directDecorations, true),
    ]),
    destructiveDecorations: directDestructive,
    interactiveDecorations: Decoration.none,
    sourceSafeDecorations: Decoration.none,
    structuralLineDecorations: directStructuralLineDecorations,
  };
  let surfaceInteractive = RangeSet.of(surfaceInteractiveDecorations, true);
  let surface = {
    atomicRanges: finishAtomicRanges(build, "surface"),
    decorations: RangeSet.of(surfaceDecorations, true),
    destructiveDecorations: RangeSet.of(surfaceDestructiveDecorations, true),
    interactiveDecorations: surfaceInteractive,
    sourceSafeDecorations: RangeSet.of(surfaceSourceSafeDecorations, true),
    structuralLineDecorations: Decoration.none,
  };
  let sourceSafe = RangeSet.join([direct.sourceSafeDecorations, surface.sourceSafeDecorations]);
  let destructive = RangeSet.join([direct.destructiveDecorations, surface.destructiveDecorations]);
  let structuralLineDecorations = RangeSet.join([
    direct.structuralLineDecorations,
    surface.structuralLineDecorations,
  ]);
  return {
    atomicRanges: RangeSet.join([direct.atomicRanges, surface.atomicRanges]),
    decorations: RangeSet.join([direct.decorations, surface.decorations]),
    destructiveDecorations: destructive,
    direct,
    interactiveDecorations: surface.interactiveDecorations,
    sourceSafeDecorations: sourceSafe,
    structuralLineDecorations,
    surface,
  };
}

export function finishAtomicRanges(
  build: LiveMdBuild,
  layer: "direct" | "surface" | "all" = "all",
) {
  let builder = new RangeSetBuilder<RangeValue>();
  let atomicRanges = collectAtomicRanges(build, layer);
  for (let { from, ownerKeys, replacementBoundary, to } of atomicRanges) {
    builder.add(
      from,
      to,
      ownerKeys.length
        ? new AtomicRange(ownerKeys, replacementBoundary)
        : replacementBoundary
          ? replacementAtomicRangeValue
          : atomicRangeValue,
    );
  }
  return builder.finish();
}

function collectLineClasses(build: LiveMdBuild) {
  let lineClasses = new Map<
    string,
    { classes: Set<string>; from: number; ownerKeys: readonly LiveMdEffectOwnerKey[] }
  >();
  for (let effect of build.effects) {
    if (effect.kind != "lineClass") continue;
    let line = build.state.doc.lineAt(Math.min(effect.from, build.state.doc.length));
    let ownerKeys = sortedOwnerKeys(effect.ownerKeys);
    let key = `${line.from}:${ownerKeys.join("\0")}`;
    let collected = lineClasses.get(key);
    if (!collected) {
      lineClasses.set(key, (collected = { classes: new Set(), from: line.from, ownerKeys }));
    }
    collected.classes.add(effect.className);
  }
  return Array.from(lineClasses.values()).sort(
    (left, right) =>
      left.from - right.from || left.ownerKeys.join("\0").localeCompare(right.ownerKeys.join("\0")),
  );
}

function collectAtomicRanges(build: LiveMdBuild, layer: "direct" | "surface" | "all") {
  let atomicRanges = new Map<
    string,
    DocRange & { ownerKeys: Set<LiveMdEffectOwnerKey>; replacementBoundary: boolean }
  >();
  for (let effect of build.effects) {
    if (effect.kind == "atomic" && layer != "surface") {
      collectAtomicRange(atomicRanges, effect.from, effect.to, effect.ownerKeys, false);
    }
    if (
      effect.kind == "replace" &&
      effect.atomic &&
      (layer == "all" || (isDirectLayoutEffect(build, effect) ? "direct" : "surface") == layer)
    ) {
      collectAtomicRange(atomicRanges, effect.from, effect.to, effect.ownerKeys, true);
    }
  }
  return Array.from(atomicRanges.values())
    .map((range) => ({
      from: range.from,
      ownerKeys: [...range.ownerKeys].sort(),
      replacementBoundary: range.replacementBoundary,
      to: range.to,
    }))
    .sort(
      (left, right) =>
        left.from - right.from ||
        Number(left.replacementBoundary) - Number(right.replacementBoundary) ||
        left.to - right.to,
    );
}

function collectAtomicRange(
  ranges: Map<
    string,
    DocRange & { ownerKeys: Set<LiveMdEffectOwnerKey>; replacementBoundary: boolean }
  >,
  from: number,
  to: number,
  ownerKeys: readonly LiveMdEffectOwnerKey[] | undefined,
  replacementBoundary: boolean,
) {
  let key = `${from}:${to}`;
  let range = ranges.get(key);
  if (!range) {
    ranges.set(key, (range = { from, ownerKeys: new Set(), replacementBoundary, to }));
  } else {
    // A separately requested atomic range keeps its established mapping
    // semantics even when it happens to coincide with a replacement.
    range.replacementBoundary &&= replacementBoundary;
  }
  for (let ownerKey of ownerKeys ?? []) range.ownerKeys.add(ownerKey);
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

export function liveMdProjectionValueOwnerKeys(value: RangeValue): readonly LiveMdEffectOwnerKey[] {
  if (value instanceof AtomicRange) return value.ownerKeys;
  if (value instanceof Decoration) {
    return ((value.spec as ProjectionOwnerSpec)[projectionOwnerKeys] ?? []) as readonly string[];
  }
  return [];
}

export function isLiveMdReplacementDecoration(value: RangeValue): value is Decoration {
  return (
    value instanceof Decoration &&
    (value.spec as ProjectionReplacementSpec)[projectionReplacementBoundary] === true
  );
}

function withProjectionOwnerKeys<T extends object>(
  spec: T,
  ownerKeys: readonly LiveMdEffectOwnerKey[] | undefined,
): T {
  if (!ownerKeys?.length) return spec;
  Object.defineProperty(spec, projectionOwnerKeys, {
    enumerable: false,
    value: [...ownerKeys].sort(),
  });
  return spec;
}

function withProjectionReplacementBoundary<T extends object>(spec: T): T {
  Object.defineProperty(spec, projectionReplacementBoundary, {
    enumerable: false,
    value: true,
  });
  return spec;
}

function sortedOwnerKeys(ownerKeys: readonly LiveMdEffectOwnerKey[] | undefined) {
  return ownerKeys?.length ? [...ownerKeys].sort() : [];
}

type ProjectionOwnerSpec = {
  [projectionOwnerKeys]?: readonly LiveMdEffectOwnerKey[];
};

type ProjectionReplacementSpec = {
  [projectionReplacementBoundary]?: true;
};

function sameArrayItems<T>(left: readonly T[], right: readonly T[]) {
  if (left.length != right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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
  return build.activeSourceRanges.some((range) => rangesOverlap(range, { from, to }));
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
