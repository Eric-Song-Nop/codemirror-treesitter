import type { Text } from "@codemirror/state";
import { highlightTree, syntaxTree } from "@codemirror-treesitter/language";
import type { TreeSitterQueryMatch } from "@codemirror-treesitter/language";
import { Decoration } from "@codemirror/view";
import {
  type LiveMdCodeFenceUnit,
  type LiveMdDocRange,
  type LiveMdImageUnit,
  type LiveMdLatexUnit,
  type LiveMdSemanticIndex,
  type LiveMdSemanticUnit,
  type LiveMdTableUnit,
} from "../analysis/index.js";
import { queryLiveMdMatchesFromSource } from "../analysis/query.js";
import type { LiveMdFeatureDecoration, LiveMdFeatureDecorateContext } from "../features.js";
import { liveMdLinkMark } from "../links.js";
import { forEachLineInRange, isWhitespaceOnly } from "../util.js";
import type { LatexFormula, MarkdownTable, MermaidDiagram } from "../widgets.js";
import { LiveMdProjectionCache } from "./cache.js";
import { LiveMdProjectionEmitter } from "./emit.js";
import type { LiveMdProjectionInput, LiveMdProjectionOutput } from "./types.js";

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
  LiveMdCodeFenceParseUnit,
  LiveMdProjectionDecoration,
  LiveMdProjectionInput,
  LiveMdProjectionOutput,
} from "./types.js";

const strongMark = Decoration.mark({ class: "cm-md-strong" });
const emphasisMark = Decoration.mark({ class: "cm-md-emphasis" });
const strikeMark = Decoration.mark({ class: "cm-md-strike" });
const inlineCodeMark = Decoration.mark({ class: "cm-md-inline-code" });
const tablePipeMark = Decoration.mark({ class: "cm-md-table-pipe" });

type LiveMdReplacementPlan = {
  range: LiveMdDocRange;
  project: () => void;
};

export function projectLiveMdSemantics(
  input: LiveMdProjectionInput,
  semantic: LiveMdSemanticIndex,
  cache = new LiveMdProjectionCache(),
): LiveMdProjectionOutput {
  let emitter = new LiveMdProjectionEmitter(input);
  projectParagraphBreaks(input, semantic, emitter);

  let replacements = replacementPlans(input, semantic, cache, emitter);
  let skipRanges = replacements.map((replacement) => replacement.range);
  for (let replacement of replacements) replacement.project();

  for (let unit of semantic.units) {
    if (unit.kind == "paragraphContainer" || rangeInsideRanges(unit.range, skipRanges)) continue;
    projectLiveMdSemanticUnit(input, unit, cache, emitter);
  }
  projectLiveMdMarkdownFeatures(input, emitter);

  return emitter.finish();
}

function replacementPlans(
  input: LiveMdProjectionInput,
  semantic: LiveMdSemanticIndex,
  cache: LiveMdProjectionCache,
  emitter: LiveMdProjectionEmitter,
) {
  let plans: LiveMdReplacementPlan[] = [];
  for (let unit of semantic.units) {
    switch (unit.kind) {
      case "codeFence": {
        let diagram = readMermaidDiagram(input, unit);
        if (!diagram || rangeTouchesActiveLine(input, unit.range.from, unit.range.to)) break;
        plans.push({
          range: unit.range,
          project: () =>
            emitter.replace(unit.range.from, unit.range.to, cache.widgets.mermaid(unit, diagram), {
              block: true,
            }),
        });
        break;
      }
      case "image": {
        let replacement = imageReplacement(input, unit);
        if (!replacement) break;
        plans.push({
          range: replacement,
          project: () =>
            emitter.replace(
              replacement.from,
              replacement.to,
              cache.widgets.image(input, unit, imageAlt(input, unit), imageSource(input, unit)),
              { block: replacement.from != unit.range.from || replacement.to != unit.range.to },
            ),
        });
        break;
      }
      case "latex": {
        let formula = readLatexFormula(input, unit);
        if (!formula || rangeTouchesActiveLine(input, unit.range.from, unit.range.to)) break;
        let replacement = latexReplacementRange(input, unit, formula.displayMode);
        plans.push({
          range: replacement,
          project: () =>
            emitter.replace(
              replacement.from,
              replacement.to,
              cache.widgets.latex(unit, { ...formula, block: replacement.block }),
              { block: replacement.block },
            ),
        });
        break;
      }
      case "table": {
        let table = readMarkdownTable(input, unit);
        if (!table || tableTouchesActiveLine(input, unit.range.from, unit.range.to, table)) break;
        plans.push({
          range: unit.range,
          project: () =>
            emitter.replace(unit.range.from, unit.range.to, cache.widgets.table(unit, table), {
              block: true,
            }),
        });
        break;
      }
    }
  }
  return plans;
}

function projectLiveMdSemanticUnit(
  input: LiveMdProjectionInput,
  unit: LiveMdSemanticUnit,
  cache: LiveMdProjectionCache,
  emitter: LiveMdProjectionEmitter,
) {
  switch (unit.kind) {
    case "blockquote":
      emitter.lineRangeClass(unit.range.from, unit.range.to, "cm-md-blockquote");
      return;
    case "codeFence":
      projectCodeFence(input, unit, cache, emitter);
      return;
    case "heading":
      emitter.lineRangeClass(unit.range.from, unit.range.to, "cm-md-heading");
      emitter.lineRangeClass(unit.range.from, unit.range.to, `cm-md-heading-${unit.level}`);
      if (unit.markerRange) emitter.syntaxVisibility(unit.markerRange.from, unit.markerRange.to);
      return;
    case "image":
      if (unit.altRange) {
        emitter.syntaxVisibility(unit.range.from, unit.altRange.from);
        emitter.mark(
          unit.altRange.from,
          unit.altRange.to,
          liveMdLinkMark(null, input.linkBaseUrl ?? null),
        );
        emitter.syntaxVisibility(unit.altRange.to, unit.range.to);
      }
      return;
    case "inlineMark":
      emitter.mark(unit.range.from, unit.range.to, inlineMarkDecoration(unit.mark));
      return;
    case "latex":
      return;
    case "link":
      if (!unit.textRange) return;
      emitter.syntaxVisibility(unit.range.from, unit.textRange.from);
      emitter.mark(
        unit.textRange.from,
        unit.textRange.to,
        liveMdLinkMark(linkDestination(input, unit), input.linkBaseUrl ?? null),
      );
      emitter.syntaxVisibility(unit.textRange.to, unit.range.to);
      return;
    case "listItem":
      emitter.lineRangeClass(unit.range.from, unit.range.to, "cm-md-list-line");
      return;
    case "listMarker":
      projectListMarker(input, unit, cache, emitter);
      return;
    case "paragraphBreak":
      for (let range of unit.breakRanges) emitter.atomicParagraphGap(range.from, range.to);
      return;
    case "paragraphContainer":
      return;
    case "rule":
      emitter.lineRangeClass(unit.range.from, unit.range.to, "cm-md-rule-line");
      emitter.syntaxVisibility(unit.range.from, unit.range.to);
      return;
    case "syntax":
      emitter.syntaxVisibility(unit.range.from, unit.range.to);
      return;
    case "table":
      projectTableSource(input, unit, emitter);
      return;
    case "taskMarker":
      projectTaskMarker(input, unit, cache, emitter);
      return;
    case "uriAutolink":
      projectUriAutolink(input, unit, emitter);
      return;
    case "capture":
      return;
  }
}

function projectListMarker(
  input: LiveMdProjectionInput,
  unit: Extract<LiveMdSemanticUnit, { kind: "listMarker" }>,
  cache: LiveMdProjectionCache,
  emitter: LiveMdProjectionEmitter,
) {
  let line = input.state.doc.lineAt(unit.range.from);
  emitter.lineClass(line.number, "cm-md-list-line");
  if (input.activeLines.has(line.number)) {
    emitter.syntaxVisibility(unit.range.from, unit.range.to);
  } else {
    emitter.replace(
      unit.range.from,
      unit.range.to,
      cache.widgets.listMarker(unit, unit.marker.trim()),
    );
  }
}

function projectTaskMarker(
  input: LiveMdProjectionInput,
  unit: Extract<LiveMdSemanticUnit, { kind: "taskMarker" }>,
  cache: LiveMdProjectionCache,
  emitter: LiveMdProjectionEmitter,
) {
  let line = input.state.doc.lineAt(unit.range.from);
  emitter.lineClass(line.number, "cm-md-list-line");
  emitter.lineClass(line.number, "cm-md-task-line");
  if (unit.checked) emitter.lineClass(line.number, "is-checked");
  emitter.replace(unit.range.from, unit.range.to, cache.widgets.taskMarker(unit, unit.checked));
}

function projectUriAutolink(
  input: LiveMdProjectionInput,
  unit: Extract<LiveMdSemanticUnit, { kind: "uriAutolink" }>,
  emitter: LiveMdProjectionEmitter,
) {
  if (unit.range.to - unit.range.from <= 2) return;
  emitter.syntaxVisibility(unit.range.from, unit.range.from + 1);
  emitter.mark(
    unit.range.from + 1,
    unit.range.to - 1,
    liveMdLinkMark(
      input.state.sliceDoc(unit.range.from + 1, unit.range.to - 1),
      input.linkBaseUrl ?? null,
    ),
  );
  emitter.syntaxVisibility(unit.range.to - 1, unit.range.to);
}

function projectCodeFence(
  input: LiveMdProjectionInput,
  unit: LiveMdCodeFenceUnit,
  cache: LiveMdProjectionCache,
  emitter: LiveMdProjectionEmitter,
) {
  if (!unit.openRange) return;
  let openingLine = input.state.doc.lineAt(unit.openRange.from);
  let blockEndLine = openingLine.number;

  emitter.lineClass(openingLine.number, "cm-md-code-fence-line");
  emitter.lineClass(openingLine.number, "cm-md-code-block-start");
  emitter.syntaxVisibility(unit.openRange.from, unit.openRange.to);

  if (unit.contentRange && unit.contentRange.from < unit.contentRange.to) {
    forEachLineInRange(input.state, unit.contentRange.from, unit.contentRange.to, (line) => {
      emitter.lineClass(line.number, "cm-md-code-line");
      blockEndLine = line.number;
    });
    projectCodeFenceHighlights(input, unit, cache, emitter);
  }

  if (unit.closeRange) {
    let closingLine = input.state.doc.lineAt(unit.closeRange.from);
    blockEndLine = closingLine.number;
    emitter.lineClass(closingLine.number, "cm-md-code-fence-line");
    emitter.syntaxVisibility(unit.closeRange.from, unit.closeRange.to);
  }

  emitter.lineClass(blockEndLine, "cm-md-code-block-end");
}

function projectCodeFenceHighlights(
  input: LiveMdProjectionInput,
  unit: LiveMdCodeFenceUnit,
  cache: LiveMdProjectionCache,
  emitter: LiveMdProjectionEmitter,
) {
  let contentRange = unit.contentRange;
  if (!contentRange || contentRange.from >= contentRange.to) return;
  if (!rangeTouchesRanges(contentRange.from, contentRange.to, input.ranges)) return;

  let parser =
    input.codeFenceLanguages.get(unit.language) ??
    input.codeFenceLanguages.get(unit.language.toLowerCase());
  if (!parser) return;

  let parse = cache.codeFences.parse(
    {
      contentFrom: contentRange.from,
      contentTo: contentRange.to,
      id: unit.id,
      language: unit.language,
      signature: unit.signature,
    },
    parser,
    () => input.state.sliceDoc(contentRange.from, contentRange.to),
  );
  emitter.addCodeFenceParse(parse);

  highlightTree(
    parse.tree,
    input.codeFenceHighlighters,
    (from, to, className) => {
      splitTextRangeByLine(parse.sourceText, from, to, (rangeFrom, rangeTo) => {
        emitter.mark(contentRange.from + rangeFrom, contentRange.from + rangeTo, className);
      });
    },
    0,
    parse.sourceText.length,
  );
}

function splitTextRangeByLine(
  text: Text,
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

function projectTableSource(
  input: LiveMdProjectionInput,
  unit: LiveMdTableUnit,
  emitter: LiveMdProjectionEmitter,
) {
  emitter.lineRangeClass(unit.range.from, unit.range.to, "cm-md-table-line");
  let delimiterLine = tableDelimiterLine(input, unit);
  if (delimiterLine) {
    emitter.lineClass(delimiterLine.number, "cm-md-table-divider");
  }
  forEachLineInRange(input.state, unit.range.from, unit.range.to, (line) => {
    for (let position = line.from; position < line.to; position++) {
      if (input.state.sliceDoc(position, position + 1) == "|") {
        emitter.mark(position, position + 1, tablePipeMark);
      }
    }
  });
}

function inlineMarkDecoration(mark: Extract<LiveMdSemanticUnit, { kind: "inlineMark" }>["mark"]) {
  switch (mark) {
    case "emphasis":
      return emphasisMark;
    case "inlineCode":
      return inlineCodeMark;
    case "strike":
      return strikeMark;
    case "strong":
      return strongMark;
    case "unknown":
      return Decoration.mark({ class: "cm-md-mark" });
  }
}

function imageReplacement(
  input: LiveMdProjectionInput,
  unit: LiveMdImageUnit,
): LiveMdDocRange | null {
  let src = imageSource(input, unit);
  if (!src) return null;
  let line = input.state.doc.lineAt(unit.range.from);
  if (input.activeLines.has(line.number)) return null;
  if (isOnlyVisibleContentOnLine(input, line.from, line.to, unit.range.from, unit.range.to)) {
    return { from: line.from, to: line.to };
  }
  return unit.range;
}

function imageAlt(input: LiveMdProjectionInput, unit: LiveMdImageUnit) {
  return unit.altRange ? input.state.sliceDoc(unit.altRange.from, unit.altRange.to) : "";
}

function imageSource(input: LiveMdProjectionInput, unit: LiveMdImageUnit) {
  return unit.destinationRange
    ? input.state.sliceDoc(unit.destinationRange.from, unit.destinationRange.to).trim()
    : "";
}

function readLatexFormula(
  input: LiveMdProjectionInput,
  unit: LiveMdLatexUnit,
): Omit<LatexFormula, "block"> | null {
  if (!unit.openRange || !unit.closeRange) return null;
  if (unit.openRange.from == unit.closeRange.from && unit.openRange.to == unit.closeRange.to) {
    return null;
  }

  let source = input.state.sliceDoc(unit.range.from, unit.range.to);
  let opening = input.state.sliceDoc(unit.openRange.from, unit.openRange.to);
  let closing = input.state.sliceDoc(unit.closeRange.from, unit.closeRange.to);
  let tex = input.state.sliceDoc(unit.openRange.to, unit.closeRange.from).trim();
  if (!tex || !closing) return null;

  return {
    displayMode: opening.length > 1 || closing.length > 1 || tex.includes("\n"),
    source,
    tex,
  };
}

function latexReplacementRange(
  input: LiveMdProjectionInput,
  unit: LiveMdLatexUnit,
  displayMode: boolean,
) {
  if (!displayMode) return { block: false, from: unit.range.from, to: unit.range.to };

  let firstLine = input.state.doc.lineAt(unit.range.from);
  let lastLine = input.state.doc.lineAt(Math.max(unit.range.from, unit.range.to - 1));
  if (
    isWhitespaceOnly(input.state.sliceDoc(firstLine.from, unit.range.from)) &&
    isWhitespaceOnly(input.state.sliceDoc(unit.range.to, lastLine.to))
  ) {
    return { block: true, from: firstLine.from, to: lastLine.to };
  }

  return { block: false, from: unit.range.from, to: unit.range.to };
}

function readMermaidDiagram(
  input: LiveMdProjectionInput,
  unit: LiveMdCodeFenceUnit,
): MermaidDiagram | null {
  if (!unit.contentRange || !isMermaidFenceLanguage(unit.language)) return null;
  let source = input.state
    .sliceDoc(unit.contentRange.from, unit.contentRange.to)
    .replace(/\s+$/u, "");
  return source.trim() ? { source } : null;
}

function isMermaidFenceLanguage(language: string) {
  return language == "mermaid" || language == "mmd";
}

function readMarkdownTable(
  input: LiveMdProjectionInput,
  unit: LiveMdTableUnit,
): MarkdownTable | null {
  let lines = tableLines(input, unit);
  if (lines.length < 2) return null;
  let delimiterIndex = lines.findIndex((line) => isPipeTableDelimiterLine(line.text));
  if (delimiterIndex < 1) return null;

  let header = splitMarkdownTableRow(lines[delimiterIndex - 1]!.text).map((cell) => cell.trim());
  let alignments = splitMarkdownTableRow(lines[delimiterIndex]!.text).map(tableAlignment);
  if (header.length < 2 || alignments.length < 2) return null;

  let columnCount = Math.max(header.length, alignments.length);
  return {
    alignments: normalizeTableAlignments(alignments, columnCount),
    header: normalizeTableCells(header, columnCount),
    rows: lines
      .slice(delimiterIndex + 1)
      .filter((line) => line.text.trim())
      .map((line) =>
        normalizeTableCells(
          splitMarkdownTableRow(line.text).map((cell) => cell.trim()),
          columnCount,
        ),
      ),
  };
}

function tableLines(input: LiveMdProjectionInput, unit: LiveMdTableUnit) {
  let first = input.state.doc.lineAt(unit.range.from);
  let last = input.state.doc.lineAt(Math.max(unit.range.from, unit.range.to - 1));
  let lines: Array<{ number: number; text: string }> = [];
  for (let lineNumber = first.number; lineNumber <= last.number; lineNumber++) {
    let line = input.state.doc.line(lineNumber);
    lines.push({ number: lineNumber, text: input.state.sliceDoc(line.from, line.to) });
  }
  return lines;
}

function tableDelimiterLine(input: LiveMdProjectionInput, unit: LiveMdTableUnit) {
  if (unit.delimiterRowRange) return input.state.doc.lineAt(unit.delimiterRowRange.from);
  for (let line of tableLines(input, unit)) {
    if (isPipeTableDelimiterLine(line.text)) return input.state.doc.line(line.number);
  }
  return null;
}

function splitMarkdownTableRow(row: string) {
  let trimmed = row.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);

  let cells: string[] = [];
  let current = "";
  let backslashes = 0;
  for (let index = 0; index < trimmed.length; index++) {
    let char = trimmed[index]!;
    if (char == "\\") {
      backslashes++;
      current += char;
      continue;
    }
    if (char == "|" && backslashes % 2 == 0) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
    backslashes = 0;
  }
  cells.push(current);
  return cells;
}

function tableAlignment(cell: string): "center" | "default" | "left" | "right" {
  let value = cell.trim();
  let left = value.startsWith(":");
  let right = value.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "default";
}

function normalizeTableCells(cells: string[], columnCount: number) {
  let normalized = cells.slice(0, columnCount);
  while (normalized.length < columnCount) normalized.push("");
  return normalized;
}

function normalizeTableAlignments(
  alignments: Array<"center" | "default" | "left" | "right">,
  columnCount: number,
) {
  let normalized = alignments.slice(0, columnCount);
  while (normalized.length < columnCount) normalized.push("default");
  return normalized;
}

function isPipeTableDelimiterLine(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableTouchesActiveLine(
  input: LiveMdProjectionInput,
  from: number,
  to: number,
  table: MarkdownTable,
) {
  if (rangeTouchesActiveLine(input, from, to)) return true;
  if (table.rows.length) return false;
  let end = Math.min(to, input.state.doc.length);
  let lastLine = input.state.doc.lineAt(Math.max(from, end - 1));
  let nextLineNumber = lastLine.number + 1;
  if (!input.activeLines.has(nextLineNumber) || nextLineNumber > input.state.doc.lines) {
    return false;
  }
  let nextLine = input.state.doc.line(nextLineNumber);
  return isWhitespaceOnly(input.state.sliceDoc(nextLine.from, nextLine.to));
}

function projectParagraphBreaks(
  input: LiveMdProjectionInput,
  semantic: LiveMdSemanticIndex,
  emitter: LiveMdProjectionEmitter,
) {
  let skipRanges = semantic.units
    .filter((unit) => unit.kind == "codeFence")
    .map((unit) => ({
      from: unit.openRange?.from ?? unit.range.from,
      to: unit.closeRange?.to ?? unit.range.to,
    }));
  for (let range of semantic.queryRanges) {
    projectParagraphBreaksInRange(input, emitter, range, skipRanges);
  }
}

function projectParagraphBreakRun(
  input: LiveMdProjectionInput,
  emitter: LiveMdProjectionEmitter,
  from: number,
  to: number,
) {
  if (from >= to || !isWhitespaceOnly(input.state.sliceDoc(from, to))) return;

  let newlinePositions: number[] = [];
  let source = input.state.sliceDoc(from, to);
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) == 10) newlinePositions.push(from + index);
  }

  let separatorCount = Math.floor(newlinePositions.length / 2);
  if (!separatorCount) return;

  let blankLines: number[] = [];
  forEachLineInRange(input.state, from, to, (line) => {
    if (line.from > from && isWhitespaceOnly(input.state.sliceDoc(line.from, line.to))) {
      blankLines.push(line.number);
    }
  });

  for (let index = 0; index < separatorCount; index++) {
    let separatorLine = blankLines[index * 2];
    emitter.atomicParagraphGap(newlinePositions[index * 2]!, newlinePositions[index * 2 + 1]! + 1, {
      line: separatorLine,
    });
  }
}

function projectParagraphBreaksInRange(
  input: LiveMdProjectionInput,
  emitter: LiveMdProjectionEmitter,
  range: LiveMdDocRange,
  skipRanges: readonly LiveMdDocRange[],
) {
  let firstLine = input.state.doc.lineAt(Math.max(0, Math.min(range.from, input.state.doc.length)));
  let lastLine = input.state.doc.lineAt(
    Math.max(0, Math.min(Math.max(range.from, range.to - 1), input.state.doc.length)),
  );
  let previousNonBlankTo: number | null = null;
  let blankRun = false;

  for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber++) {
    let line = input.state.doc.line(lineNumber);
    let skipRange = containingRange({ from: line.from, to: line.to }, skipRanges);
    if (skipRange) {
      let skipFrom = Math.max(skipRange.from, range.from);
      let skipTo = Math.min(skipRange.to, range.to);
      let skipStartLine = input.state.doc.lineAt(skipFrom);
      let skipEndLine = input.state.doc.lineAt(Math.max(skipFrom, skipTo - 1));
      if (blankRun && previousNonBlankTo != null) {
        projectParagraphBreakRun(input, emitter, previousNonBlankTo, skipStartLine.from);
      }
      previousNonBlankTo = skipEndLine.to;
      blankRun = false;
      lineNumber = Math.max(lineNumber, skipEndLine.number);
      continue;
    }

    let blank = isWhitespaceOnly(input.state.sliceDoc(line.from, line.to));
    if (!blank) {
      if (blankRun && previousNonBlankTo != null) {
        projectParagraphBreakRun(input, emitter, previousNonBlankTo, line.from);
      }
      previousNonBlankTo = line.to;
      blankRun = false;
      continue;
    }

    if (previousNonBlankTo != null) blankRun = true;
  }

  if (blankRun && previousNonBlankTo != null) {
    projectParagraphBreakRun(input, emitter, previousNonBlankTo, range.to);
  }
}

function projectLiveMdMarkdownFeatures(
  input: LiveMdProjectionInput,
  emitter: LiveMdProjectionEmitter,
) {
  if (!input.markdownFeatures?.length) return;
  for (let feature of input.markdownFeatures) {
    if (!feature.query || !feature.decorate) continue;
    let matches = queryLiveMdMatchesFromSource(
      syntaxTree(input.state),
      feature.query,
      input.ranges,
      feature.includeNested ?? false,
    );
    for (let { match } of matches) {
      feature.decorate(createLiveMdFeatureDecorateContext(input, emitter, match));
    }
  }
}

function createLiveMdFeatureDecorateContext(
  input: LiveMdProjectionInput,
  emitter: LiveMdProjectionEmitter,
  match: TreeSitterQueryMatch,
): LiveMdFeatureDecorateContext {
  return {
    activeLines: input.activeLines,
    addAtomicRange(from, to) {
      emitter.atomicRange(from, to);
    },
    addLineClass(from, to, className) {
      emitter.lineRangeClass(from, to, className);
    },
    addMark(from, to, decoration) {
      emitter.mark(from, to, liveMdFeatureDecoration(decoration));
    },
    addReplace(from, to, widget, options) {
      emitter.replace(from, to, widget, options);
    },
    addSyntax(from, to, decoration) {
      emitter.syntaxVisibility(from, to, {
        hiddenDecoration: decoration ? liveMdFeatureDecoration(decoration) : undefined,
      });
    },
    capture: (name) => capture(match, name),
    captures: (name) => captures(match, name),
    match,
    node: (name) => capture(match, name)?.node ?? null,
    nodes: (name) => captures(match, name).map((item) => item.node),
    rangeTouchesActiveLine: (from, to) => rangeTouchesActiveLine(input, from, to),
    ranges: input.ranges,
    slice: (node) => input.state.sliceDoc(node.from, node.to),
    state: input.state,
  };
}

function liveMdFeatureDecoration(decoration: LiveMdFeatureDecoration) {
  return typeof decoration == "string" ? Decoration.mark({ class: decoration }) : decoration;
}

function capture(match: TreeSitterQueryMatch, name: string) {
  return match.captures.find((item) => item.name == name) ?? null;
}

function captures(match: TreeSitterQueryMatch, name: string) {
  return match.captures.filter((item) => item.name == name);
}

function linkDestination(
  input: LiveMdProjectionInput,
  unit: Extract<LiveMdSemanticUnit, { kind: "link" }>,
) {
  return unit.destinationRange
    ? input.state.sliceDoc(unit.destinationRange.from, unit.destinationRange.to)
    : null;
}

function rangeTouchesActiveLine(input: LiveMdProjectionInput, from: number, to: number) {
  let firstLine = input.state.doc.lineAt(from).number;
  let lastLine = input.state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber of input.activeLines) {
    if (lineNumber >= firstLine && lineNumber <= lastLine) return true;
  }
  return false;
}

function rangeTouchesRanges(from: number, to: number, ranges: readonly LiveMdDocRange[]) {
  return ranges.some((range) => from < range.to && to > range.from);
}

function rangeInsideRanges(range: LiveMdDocRange, ranges: readonly LiveMdDocRange[]) {
  return ranges.some((skip) => range.from >= skip.from && range.to <= skip.to);
}

function containingRange(range: LiveMdDocRange, ranges: readonly LiveMdDocRange[]) {
  return ranges.find((skip) => range.from >= skip.from && range.to <= skip.to) ?? null;
}

function isOnlyVisibleContentOnLine(
  input: LiveMdProjectionInput,
  lineFrom: number,
  lineTo: number,
  contentFrom: number,
  contentTo: number,
) {
  return (
    isWhitespaceOnly(input.state.sliceDoc(lineFrom, contentFrom)) &&
    isWhitespaceOnly(input.state.sliceDoc(contentTo, lineTo))
  );
}
