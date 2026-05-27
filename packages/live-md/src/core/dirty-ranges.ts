import type { ChangeDesc, EditorState } from "@codemirror/state";
import { syntaxTree, type DocRange, type SyntaxNode } from "@codemirror-treesitter/language";
import type { LiveMdFeatureRegistry, LiveMdScope } from "./features.js";

export type LiveMdDirtyReason = "codeFenceLanguages" | "selection" | "syntax" | "text";

export type LiveMdDirtyRange = {
  from: number;
  reasons: readonly LiveMdDirtyReason[];
  to: number;
};

export type LiveMdDirtySourceRange = {
  from: number;
  reason: LiveMdDirtyReason;
  to: number;
};

export type CollectLiveMdDirtyRangesInput = {
  activeLines?: readonly number[];
  changes: ChangeDesc;
  previousActiveLines?: readonly number[];
  sourceRanges?: readonly LiveMdDirtySourceRange[];
  startState: EditorState;
  state: EditorState;
  syntaxChangedRanges?: readonly DocRange[];
};

export type ExpandLiveMdDirtyRangesInput = {
  ranges: readonly LiveMdDirtyRange[];
  registry: LiveMdDirtyRangeRegistry;
  state: EditorState;
};

type LiveMdDirtyRangeRegistry = Pick<
  LiveMdFeatureRegistry<unknown, SyntaxNode>,
  "hasNode" | "scopeFor"
>;

export function collectLiveMdDirtyRanges(input: CollectLiveMdDirtyRangesInput): LiveMdDirtyRange[] {
  let ranges: MutableDirtyRange[] = [];

  input.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    ranges.push({ from: fromB, reasons: new Set(["text"]), to: toB });
  });

  for (let range of input.syntaxChangedRanges ?? []) {
    ranges.push({ from: range.from, reasons: new Set(["syntax"]), to: range.to });
  }

  for (let lineNumber of input.previousActiveLines ?? []) {
    addLineRange(ranges, input.startState, lineNumber, "selection");
  }
  for (let lineNumber of input.activeLines ?? []) {
    addLineRange(ranges, input.state, lineNumber, "selection");
  }

  for (let range of input.sourceRanges ?? []) {
    ranges.push({
      from: range.from,
      reasons: new Set([range.reason]),
      to: range.to,
    });
  }

  return mergeDirtyRanges(ranges);
}

export const __testCollectLiveMdDirtyRanges = collectLiveMdDirtyRanges;

export type CollectSyntaxNodeDirtyRangesInput = {
  nodes: readonly string[];
  reason: LiveMdDirtyReason;
  state: EditorState;
};

export function collectSyntaxNodeDirtyRanges(
  input: CollectSyntaxNodeDirtyRangesInput,
): LiveMdDirtySourceRange[] {
  let nodes = new Set(input.nodes);
  let ranges: LiveMdDirtySourceRange[] = [];
  syntaxTree(input.state).iterate({
    enter(node) {
      if (nodes.has(node.name)) {
        ranges.push({ from: node.from, reason: input.reason, to: node.to });
      }
    },
  });
  return ranges;
}

export function expandLiveMdDirtyRanges(input: ExpandLiveMdDirtyRangesInput): LiveMdDirtyRange[] {
  let ranges = input.ranges.map((range) => expandDirtyRange(input.state, input.registry, range));
  return mergeDirtyRanges(
    ranges.map((range) => ({
      from: range.from,
      reasons: new Set(range.reasons),
      to: range.to,
    })),
  );
}

type MutableDirtyRange = {
  from: number;
  reasons: Set<LiveMdDirtyReason>;
  to: number;
};

const reasonOrder: readonly LiveMdDirtyReason[] = [
  "text",
  "syntax",
  "selection",
  "codeFenceLanguages",
];

function addLineRange(
  ranges: MutableDirtyRange[],
  state: EditorState,
  lineNumber: number,
  reason: LiveMdDirtyReason,
) {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return;
  let line = state.doc.line(lineNumber);
  ranges.push({ from: line.from, reasons: new Set([reason]), to: line.to });
}

function mergeDirtyRanges(ranges: MutableDirtyRange[]): LiveMdDirtyRange[] {
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  let merged: MutableDirtyRange[] = [];
  for (let range of ranges) {
    let last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
      for (let reason of range.reasons) last.reasons.add(reason);
    } else {
      merged.push({
        from: range.from,
        reasons: new Set(range.reasons),
        to: range.to,
      });
    }
  }
  return merged.map((range) => ({
    from: range.from,
    reasons: reasonOrder.filter((reason) => range.reasons.has(reason)),
    to: range.to,
  }));
}

function expandDirtyRange(
  state: EditorState,
  registry: LiveMdDirtyRangeRegistry,
  range: LiveMdDirtyRange,
): LiveMdDirtyRange {
  let match = smallestFeatureNode(state, registry, range);
  let expanded = match
    ? expandByScope(state, range, match, registry.scopeFor(match.name))
    : expandToTouchedLines(state, range);
  return {
    ...cover(range, expanded),
    reasons: range.reasons,
  };
}

function cover(
  range: Pick<LiveMdDirtyRange, "from" | "to">,
  expanded: Pick<LiveMdDirtyRange, "from" | "to">,
) {
  return {
    from: Math.min(range.from, expanded.from),
    to: Math.max(range.to, expanded.to),
  };
}

function smallestFeatureNode(
  state: EditorState,
  registry: LiveMdDirtyRangeRegistry,
  range: LiveMdDirtyRange,
): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  syntaxTree(state).iterate({
    from: range.from,
    to: range.to,
    enter(node) {
      if (!registry.hasNode(node.name) || !touches(node.from, node.to, range.from, range.to)) {
        return;
      }
      if (!found || node.to - node.from < found.to - found.from) found = node;
    },
  });
  return found;
}

function expandByScope(
  state: EditorState,
  range: LiveMdDirtyRange,
  node: SyntaxNode,
  scope: LiveMdScope,
) {
  switch (scope) {
    case "document":
      return { from: 0, to: state.doc.length };
    case "line":
      return expandToTouchedLines(state, range);
    case "block":
    case "container":
    case "node":
      return { from: node.from, to: node.to };
  }
}

function expandToTouchedLines(state: EditorState, range: Pick<LiveMdDirtyRange, "from" | "to">) {
  let from = clamp(range.from, 0, state.doc.length);
  let to = clamp(range.to, 0, state.doc.length);
  let firstLine = state.doc.lineAt(from);
  let lastLine = state.doc.lineAt(Math.max(from, to - 1));
  return { from: firstLine.from, to: lastLine.to };
}

function touches(nodeFrom: number, nodeTo: number, rangeFrom: number, rangeTo: number) {
  return rangeFrom == rangeTo
    ? nodeFrom <= rangeFrom && nodeTo >= rangeFrom
    : nodeFrom < rangeTo && nodeTo > rangeFrom;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
