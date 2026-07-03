import { type Text } from "@codemirror/state";
import {
  queryTreeMatches,
  type SyntaxNode,
  type Tree,
  type TreeSitterQueryMatch,
} from "@codemirror-treesitter/language";
import { deleteLiveMdTree, type LiveMdMarkdownParserService } from "../languages.js";
import { type LiveMdDescriptor, liveMdDescriptorRanges } from "./descriptors.js";
import {
  capture,
  captureKey,
  isInsideSkippedRange,
  liveMdMarkdownInlineQuerySource,
  matchKind,
  matchRoot,
} from "./query.js";
import { type DocRange, type LiveMdLeafAnalysisTrace } from "./types.js";

export type MarkdownInlineAnalysisInput = {
  blockTree: Tree;
  doc: Text;
  service: LiveMdMarkdownParserService;
  within: DocRange;
};

export type MarkdownInlineAnalysisSessionInput = Omit<MarkdownInlineAnalysisInput, "within"> & {
  trace?: LiveMdLeafAnalysisTrace;
};

export type MarkdownInlineAnalysisSession = {
  analyze(within: DocRange): LiveMdDescriptor[];
  dispose(): void;
};

type SimpleInlineCaptureHandler = (
  doc: Text,
  descriptors: LiveMdDescriptor[],
  node: SyntaxNode,
) => void;

type MarkdownInlineAnalysisContext = MarkdownInlineAnalysisSessionInput & {
  descriptorCache: Map<string, LiveMdDescriptor[]>;
};

const simpleInlineCaptureHandlers: Record<string, SimpleInlineCaptureHandler> = {
  "mark.emphasis": (_doc, descriptors, node) => addTextMark(descriptors, node, "emphasis"),
  "mark.inlineCode": (_doc, descriptors, node) => addTextMark(descriptors, node, "inlineCode"),
  "mark.strike": (_doc, descriptors, node) => addTextMark(descriptors, node, "strike"),
  "mark.strong": (_doc, descriptors, node) => addTextMark(descriptors, node, "strong"),
  syntax: (_doc, descriptors, node) => addSyntax(descriptors, nodeRange(node)),
  uriAutolink: applyUriAutolink,
};

export function analyzeMarkdownInlineDescriptors(
  input: MarkdownInlineAnalysisInput,
): LiveMdDescriptor[] {
  let session = createMarkdownInlineAnalysisSession(input);
  try {
    return session.analyze(input.within);
  } finally {
    session.dispose();
  }
}

export function createMarkdownInlineAnalysisSession(
  input: MarkdownInlineAnalysisSessionInput,
): MarkdownInlineAnalysisSession {
  let parser = input.service.inlineParser.createParser();
  let context: MarkdownInlineAnalysisContext = {
    ...input,
    descriptorCache: new Map(),
  };
  let disposed = false;
  if (input.trace) input.trace.inlineParserSessions++;
  return {
    analyze(within) {
      if (disposed) throw new RangeError("Markdown inline analysis session has been disposed");
      return analyzeMarkdownInlineDescriptorsWithParser(context, parser, within);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      parser.delete();
    },
  };
}

function analyzeMarkdownInlineDescriptorsWithParser(
  input: MarkdownInlineAnalysisContext,
  parser: ReturnType<LiveMdMarkdownParserService["inlineParser"]["createParser"]>,
  within: DocRange,
): LiveMdDescriptor[] {
  let rangeGroups = clipRangeGroups(input.service.inlineRanges(input.blockTree, within), within);
  if (within.from < within.to && !rangeGroups.length) {
    if (input.trace) input.trace.inlineHostsWithoutRanges++;
    return [];
  }
  if (!rangeGroups.length) return [];

  let descriptors: LiveMdDescriptor[] = [];
  for (let ranges of rangeGroups) {
    descriptors.push(...descriptorsForRangeGroup(input, parser, ranges));
  }
  return filterDescriptorsToRange(dedupeDescriptors(descriptors), within);
}

function descriptorsForRangeGroup(
  input: MarkdownInlineAnalysisContext,
  parser: ReturnType<LiveMdMarkdownParserService["inlineParser"]["createParser"]>,
  ranges: readonly DocRange[],
): readonly LiveMdDescriptor[] {
  let key = rangeGroupKey(ranges);
  let cached = input.descriptorCache.get(key);
  if (cached) return cached;

  let descriptors: LiveMdDescriptor[] = [];
  if (input.trace) {
    input.trace.inlineRangeGroupsExamined++;
    input.trace.inlineParseCalls++;
    input.trace.inlineParsedChars += rangeGroupLength(ranges);
  }

  let parsed = input.service.inlineParser.parseWith(parser, input.doc, null, undefined, ranges);
  if (!parsed) {
    input.descriptorCache.set(key, descriptors);
    return descriptors;
  }

  let tree: ReturnType<LiveMdMarkdownParserService["inlineParser"]["wrapTree"]> = null;
  try {
    tree = input.service.inlineParser.wrapTree(parsed, input.doc);
    if (!tree) {
      input.descriptorCache.set(key, descriptors);
      return descriptors;
    }

    for (let range of ranges) {
      processInlineMatches(
        input.doc,
        queryTreeMatches(tree, liveMdMarkdownInlineQuerySource, {
          from: range.from,
          includeNested: false,
          to: range.to,
        }),
        descriptors,
      );
    }
    input.descriptorCache.set(key, descriptors);
    return descriptors;
  } finally {
    if (tree) deleteLiveMdTree(tree);
    else parsed.delete();
  }
}

function clipRangeGroups(rangeGroups: DocRange[][], within: DocRange) {
  return rangeGroups
    .map((ranges) => ranges.map((range) => clipRange(range, within)).filter(isDocRange))
    .filter((ranges) => ranges.length > 0);
}

function rangeGroupKey(ranges: readonly DocRange[]) {
  return ranges.map((range) => `${range.from}:${range.to}`).join(",");
}

function rangeGroupLength(ranges: readonly DocRange[]) {
  let length = 0;
  for (let range of ranges) {
    length += range.to - range.from;
  }
  return length;
}

function clipRange(range: DocRange, within: DocRange): DocRange | null {
  let from = Math.max(range.from, within.from);
  let to = Math.min(range.to, within.to);
  return from < to ? { from, to } : null;
}

function isDocRange(range: DocRange | null): range is DocRange {
  return !!range;
}

function filterDescriptorsToRange(
  descriptors: readonly LiveMdDescriptor[],
  within: DocRange,
): LiveMdDescriptor[] {
  return descriptors.filter((descriptor) =>
    liveMdDescriptorRanges(descriptor).every((range) => rangeInside(range, within)),
  );
}

function rangeInside(range: DocRange, within: DocRange) {
  return range.from >= within.from && range.to <= within.to;
}

function processInlineMatches(
  doc: Text,
  matches: readonly TreeSitterQueryMatch[],
  descriptors: LiveMdDescriptor[],
) {
  let skipped: DocRange[] = [];
  let processed = new Set<string>();

  for (let match of matches) {
    let root = matchRoot(match);
    if (root && isInsideSkippedRange(root, skipped)) continue;
    if (processInlineMatch(doc, match, descriptors, processed) === false && root) {
      skipped.push(nodeRange(root));
    }
  }
}

function processInlineMatch(
  doc: Text,
  match: TreeSitterQueryMatch,
  descriptors: LiveMdDescriptor[],
  processed: Set<string>,
): false | void {
  switch (matchKind(match)) {
    case "image":
      return applyImage(doc, match, descriptors);
    case "latex":
      return applyLatex(doc, match, descriptors);
    case "link":
      return applyInlineLink(doc, match, descriptors);
  }

  for (let item of match.captures) {
    let handler = simpleInlineCaptureHandlers[item.name];
    if (!handler) continue;
    let key = captureKey(item);
    if (processed.has(key)) continue;
    processed.add(key);
    handler(doc, descriptors, item.node);
  }
}

function applyInlineLink(
  doc: Text,
  match: TreeSitterQueryMatch,
  descriptors: LiveMdDescriptor[],
): false | void {
  let node = capture(match, "link")?.node;
  let text = capture(match, "link.text")?.node;
  let destination = capture(match, "link.destination")?.node;
  if (!node || !text) return;

  addSyntax(descriptors, { from: node.from, to: text.from });
  descriptors.push({
    destination: destination ? doc.sliceString(destination.from, destination.to) : null,
    kind: "linkMark",
    range: nodeRange(text),
    sourceRange: nodeRange(node),
  });
  addSyntax(descriptors, { from: text.to, to: node.to });
  return false;
}

function applyUriAutolink(doc: Text, descriptors: LiveMdDescriptor[], node: SyntaxNode) {
  if (node.to - node.from <= 2) return;
  addSyntax(descriptors, { from: node.from, to: node.from + 1 });
  descriptors.push({
    destination: doc.sliceString(node.from + 1, node.to - 1),
    kind: "linkMark",
    range: { from: node.from + 1, to: node.to - 1 },
    sourceRange: nodeRange(node),
  });
  addSyntax(descriptors, { from: node.to - 1, to: node.to });
}

function applyImage(
  doc: Text,
  match: TreeSitterQueryMatch,
  descriptors: LiveMdDescriptor[],
): false | void {
  let node = capture(match, "image")?.node;
  if (!node) return false;

  let description = capture(match, "image.description")?.node ?? null;
  let destination = capture(match, "image.destination")?.node ?? null;
  let source = destination ? doc.sliceString(destination.from, destination.to).trim() : "";
  if (!source) return false;

  let line = doc.lineAt(node.from);
  descriptors.push({
    alt: description ? doc.sliceString(description.from, description.to) : "",
    descriptionRange: description ? nodeRange(description) : null,
    destinationRange: destination ? nodeRange(destination) : null,
    kind: "image",
    lineRange: { from: line.from, to: line.to },
    range: nodeRange(node),
    source,
  });
  return false;
}

function applyLatex(
  doc: Text,
  match: TreeSitterQueryMatch,
  descriptors: LiveMdDescriptor[],
): false | void {
  let node = capture(match, "latex")?.node;
  let openingDelimiter = capture(match, "latex.open")?.node;
  let closingDelimiter = capture(match, "latex.close")?.node;
  if (!node || !openingDelimiter || !closingDelimiter) return false;

  let formula = readLatexFormula(doc, node, openingDelimiter, closingDelimiter);
  if (!formula) return false;

  descriptors.push({
    formula: {
      ...formula,
      replacementRange: latexReplacementRange(doc, node, formula.displayMode),
    },
    kind: "latex",
    range: nodeRange(node),
  });
  return false;
}

function readLatexFormula(
  doc: Text,
  node: SyntaxNode,
  openingDelimiter: SyntaxNode,
  closingDelimiter: SyntaxNode,
) {
  if (openingDelimiter == closingDelimiter) return null;

  let source = doc.sliceString(node.from, node.to);
  let opening = doc.sliceString(openingDelimiter.from, openingDelimiter.to);
  let closing = doc.sliceString(closingDelimiter.from, closingDelimiter.to);
  let tex = doc.sliceString(openingDelimiter.to, closingDelimiter.from).trim();
  if (!tex) return null;

  return {
    displayMode: opening.length > 1 || closing.length > 1 || tex.includes("\n"),
    source,
    tex,
  };
}

function latexReplacementRange(doc: Text, node: SyntaxNode, displayMode: boolean) {
  if (!displayMode) return { block: false, from: node.from, to: node.to };

  let firstLine = doc.lineAt(node.from);
  let lastLine = doc.lineAt(Math.max(node.from, node.to - 1));
  if (
    isWhitespaceOnly(doc.sliceString(firstLine.from, node.from)) &&
    isWhitespaceOnly(doc.sliceString(node.to, lastLine.to))
  ) {
    return { block: true, from: firstLine.from, to: lastLine.to };
  }

  return { block: false, from: node.from, to: node.to };
}

function addTextMark(
  descriptors: LiveMdDescriptor[],
  node: SyntaxNode,
  mark: Extract<LiveMdDescriptor, { kind: "textMark" }>["mark"],
) {
  descriptors.push({ kind: "textMark", mark, range: nodeRange(node) });
}

function addSyntax(descriptors: LiveMdDescriptor[], range: DocRange) {
  if (range.from < range.to) descriptors.push({ kind: "syntax", range });
}

function dedupeDescriptors(descriptors: readonly LiveMdDescriptor[]) {
  let deduped: LiveMdDescriptor[] = [];
  let seen = new Set<string>();
  for (let descriptor of descriptors) {
    let key = JSON.stringify(descriptor);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(descriptor);
  }
  return deduped;
}

function nodeRange(node: SyntaxNode): DocRange {
  return { from: node.from, to: node.to };
}

function isWhitespaceOnly(value: string) {
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    if (code != 9 && code != 10 && code != 13 && code != 32) return false;
  }
  return true;
}
