import { RangeSet, RangeSetBuilder, RangeValue } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { isWhitespaceOnly, forEachLineInRange, splitRangeByLine } from "../util.js";
import { type MarkdownTable } from "../widgets.js";
import { type LiveMdBuild, type LiveMdBuildConfig } from "../analysis/types.js";

const visibleSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" });
const hiddenSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-hidden" });

class AtomicRange extends RangeValue {
  eq(other: RangeValue) {
    return other instanceof AtomicRange;
  }
}

const paragraphBreakAtom = new AtomicRange();

export function createLiveMdBuild(config: LiveMdBuildConfig): LiveMdBuild {
  return {
    activeLines: config.activeLines,
    atomicRanges: [],
    codeFenceHighlightTrees: [],
    codeFenceHighlighters: config.codeFenceHighlighters,
    codeFenceLanguages: config.codeFenceLanguages,
    decorations: [],
    imageSourceResolver: config.imageSourceResolver,
    lineClasses: new Map(),
    linkBaseUrl: config.linkBaseUrl,
    markdownFeatures: config.markdownFeatures,
    state: config.state,
  };
}

export function addLineClass(build: LiveMdBuild, lineNumber: number, className: string) {
  let classes = build.lineClasses.get(lineNumber);
  if (!classes) build.lineClasses.set(lineNumber, (classes = new Set()));
  classes.add(className);
}

export function addLineRangeClass(build: LiveMdBuild, from: number, to: number, className: string) {
  forEachLineInRange(build.state, from, to, (docLine) =>
    addLineClass(build, docLine.number, className),
  );
}

export function addAtom(build: LiveMdBuild, from: number, to: number) {
  if (from < to) build.atomicRanges.push({ from, to });
}

export function addMark(build: LiveMdBuild, from: number, to: number, decoration: Decoration) {
  if (from < to) build.decorations.push(decoration.range(from, to));
}

function addMarkByLine(
  build: LiveMdBuild,
  from: number,
  to: number,
  decorationForLine: (lineNumber: number) => Decoration,
) {
  splitRangeByLine(build.state, from, to, (lineNumber, rangeFrom, rangeTo) => {
    addMark(build, rangeFrom, rangeTo, decorationForLine(lineNumber));
  });
}

export function addReplace(
  build: LiveMdBuild,
  from: number,
  to: number,
  widget: WidgetType,
  block = false,
) {
  addMark(build, from, to, Decoration.replace({ block, widget }));
}

export function addSyntax(build: LiveMdBuild, from: number, to: number, decoration?: Decoration) {
  addMarkByLine(build, from, to, (lineNumber) => {
    if (decoration) return decoration;
    return build.activeLines.has(lineNumber) ? visibleSyntax : hiddenSyntax;
  });
}

export function finishDecorations(build: LiveMdBuild) {
  let lineDecorations = new RangeSetBuilder<Decoration>();
  let lineClasses = Array.from(build.lineClasses).sort(
    ([leftLine], [rightLine]) => leftLine - rightLine,
  );
  for (let [lineNumber, classes] of lineClasses) {
    let docLine = build.state.doc.line(lineNumber);
    lineDecorations.add(
      docLine.from,
      docLine.from,
      Decoration.line({ class: [...classes].join(" ") }),
    );
  }
  return RangeSet.join([lineDecorations.finish(), RangeSet.of(build.decorations, true)]);
}

export function finishAtomicRanges(build: LiveMdBuild) {
  let builder = new RangeSetBuilder<RangeValue>();
  build.atomicRanges.sort((left, right) => left.from - right.from || left.to - right.to);
  for (let { from, to } of build.atomicRanges) {
    builder.add(from, to, paragraphBreakAtom);
  }
  return builder.finish();
}

export function rangeTouchesActiveLine(build: LiveMdBuild, from: number, to: number) {
  let firstLine = build.state.doc.lineAt(from).number;
  let lastLine = build.state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber of build.activeLines) {
    if (lineNumber >= firstLine && lineNumber <= lastLine) return true;
  }
  return false;
}

export function tableTouchesActiveLine(
  build: LiveMdBuild,
  from: number,
  to: number,
  table: MarkdownTable,
) {
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
