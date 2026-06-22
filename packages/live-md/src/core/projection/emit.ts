import { RangeSet, RangeSetBuilder, RangeValue, type Range } from "@codemirror/state";
import { Decoration, type WidgetType } from "@codemirror/view";
import { isWhitespaceOnly, forEachLineInRange, splitRangeByLine } from "../util.js";
import { type MarkdownTable } from "../widgets.js";
import {
  type DocRange,
  type LiveMdBuild,
  type LiveMdBuildConfig,
  type LiveMdEffect,
} from "../analysis/types.js";

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
    codeFenceHighlightTrees: [],
    codeFenceHighlighters: config.codeFenceHighlighters,
    codeFenceLanguages: config.codeFenceLanguages,
    effects: [],
    imageSourceResolver: config.imageSourceResolver,
    linkBaseUrl: config.linkBaseUrl,
    markdownFeatures: config.markdownFeatures,
    sourceIslandMode: config.sourceIslandMode ?? false,
    state: config.state,
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
  let lineDecorations = new RangeSetBuilder<Decoration>();
  let lineClasses = collectLineClasses(build);
  for (let [lineFrom, classes] of lineClasses) {
    lineDecorations.add(lineFrom, lineFrom, Decoration.line({ class: [...classes].join(" ") }));
  }

  let decorations: Array<Range<Decoration>> = [];
  for (let effect of build.effects) {
    switch (effect.kind) {
      case "lineClass":
      case "atomic":
        break;
      case "mark":
        decorations.push(effect.decoration.range(effect.from, effect.to));
        break;
      case "replace":
        decorations.push(
          Decoration.replace({ block: effect.block ?? false, widget: effect.widget }).range(
            effect.from,
            effect.to,
          ),
        );
        break;
      case "syntax":
        addSyntaxDecorations(build, decorations, effect);
        break;
    }
  }
  return RangeSet.join([lineDecorations.finish(), RangeSet.of(decorations, true)]);
}

export function finishAtomicRanges(build: LiveMdBuild) {
  let builder = new RangeSetBuilder<RangeValue>();
  let atomicRanges = collectAtomicRanges(build.effects);
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

function collectAtomicRanges(effects: readonly LiveMdEffect[]) {
  let atomicRanges: DocRange[] = [];
  let seen = new Set<string>();
  for (let effect of effects) {
    if (effect.kind == "atomic") collectAtomicRange(atomicRanges, seen, effect.from, effect.to);
    if (effect.kind == "replace" && effect.atomic)
      collectAtomicRange(atomicRanges, seen, effect.from, effect.to);
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
  decorations: Array<Range<Decoration>>,
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
    (from, to, decoration) => decorations.push(decoration.range(from, to)),
  );
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
