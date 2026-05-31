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

export type LiveMdDirtyInvalidation = {
  nodes: readonly string[];
  reason: LiveMdDirtyReason;
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

export type AnalyzeLiveMdDirtyRangesInput = CollectLiveMdDirtyRangesInput & {
  invalidations?: readonly LiveMdDirtyInvalidation[];
  registry: LiveMdDirtyRangeRegistry;
};

export type LiveMdDirtyAnalysis = {
  dirtyRanges: LiveMdDirtyRange[];
  expandedDirtyRanges: LiveMdDirtyRange[];
};

export type LiveMdDirtyRangeRegistry = Pick<
  LiveMdFeatureRegistry<unknown, SyntaxNode>,
  "hasNode" | "scopeFor"
>;

export function analyzeLiveMdDirtyRanges(
  input: AnalyzeLiveMdDirtyRangesInput,
): LiveMdDirtyAnalysis {
  let dirtyRanges = collectLiveMdDirtyRanges({
    ...input,
    sourceRanges: [
      ...(input.sourceRanges ?? []),
      ...collectTreeSeededSyntaxDirtyRanges(input),
      ...collectInvalidatedSyntaxNodeDirtyRanges(input.state, input.invalidations ?? []),
    ],
  });
  return {
    dirtyRanges,
    expandedDirtyRanges: expandLiveMdDirtyRanges({
      ranges: dirtyRanges,
      registry: input.registry,
      state: input.state,
    }),
  };
}

export function collectLiveMdDirtyRanges(input: CollectLiveMdDirtyRangesInput): LiveMdDirtyRange[] {
  let ranges: MutableDirtyRange[] = [];

  input.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    ranges.push({ from: fromB, reasons: new Set(["text"]), to: toB });
  });

  for (let range of input.syntaxChangedRanges ?? []) {
    addDirtyRange(ranges, input.state, range.from, range.to, "syntax");
  }

  for (let lineNumber of input.previousActiveLines ?? []) {
    addLineRange(ranges, input.startState, lineNumber, "selection");
  }
  for (let lineNumber of input.activeLines ?? []) {
    addLineRange(ranges, input.state, lineNumber, "selection");
  }

  for (let range of input.sourceRanges ?? []) {
    addDirtyRange(ranges, input.state, range.from, range.to, range.reason);
  }

  return mergeDirtyRanges(ranges);
}

export const __testCollectLiveMdDirtyRanges = collectLiveMdDirtyRanges;

function collectTreeSeededSyntaxDirtyRanges(
  input: Pick<AnalyzeLiveMdDirtyRangesInput, "changes" | "registry" | "startState" | "state">,
): LiveMdDirtySourceRange[] {
  let ranges: LiveMdDirtySourceRange[] = [];
  input.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    let oldContext = featureContext(input.startState, input.registry, { from: fromA, to: toA });
    let newContext = featureContext(input.state, input.registry, { from: fromB, to: toB });
    if (sameContext(oldContext, newContext)) return;
    ranges.push({ from: fromB, reason: "syntax", to: toB });
  });
  return ranges;
}

function featureContext(
  state: EditorState,
  registry: LiveMdDirtyRangeRegistry,
  range: Pick<LiveMdDirtyRange, "from" | "to">,
) {
  let names = new Set<string>();
  for (let boundary of dirtyBoundaries(state, range)) {
    for (
      let current: SyntaxNodeIterator | null = syntaxTree(state).resolveStack(
        boundary.pos,
        boundary.side,
      );
      current;
      current = current.next
    ) {
      if (registry.hasNode(current.node.name)) names.add(current.node.name);
    }
  }
  return Array.from(names).sort();
}

function sameContext(left: readonly string[], right: readonly string[]) {
  return left.length == right.length && left.every((name, index) => name == right[index]);
}

export type CollectSyntaxNodeDirtyRangesInput = {
  nodes: readonly string[];
  reason: LiveMdDirtyReason;
  state: EditorState;
};

export function collectSyntaxNodeDirtyRanges(
  input: CollectSyntaxNodeDirtyRangesInput,
): LiveMdDirtySourceRange[] {
  return collectInvalidatedSyntaxNodeDirtyRanges(input.state, [
    { nodes: input.nodes, reason: input.reason },
  ]);
}

function collectInvalidatedSyntaxNodeDirtyRanges(
  state: EditorState,
  invalidations: readonly LiveMdDirtyInvalidation[],
): LiveMdDirtySourceRange[] {
  let reasonsByNode = new Map<string, LiveMdDirtyReason[]>();
  for (let invalidation of invalidations) {
    for (let node of invalidation.nodes) {
      addReason(reasonsByNode, node, invalidation.reason);
    }
  }
  if (!reasonsByNode.size) return [];

  let ranges: LiveMdDirtySourceRange[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      for (let reason of reasonsByNode.get(node.name) ?? []) {
        let range = clampRange(state, node);
        ranges.push({ from: range.from, reason, to: range.to });
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

type SyntaxNodeIterator = {
  next: SyntaxNodeIterator | null;
  node: SyntaxNode;
};

type DirtyBoundary = {
  from: number;
  pos: number;
  side: -1 | 0 | 1;
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

function addDirtyRange(
  ranges: MutableDirtyRange[],
  state: EditorState,
  from: number,
  to: number,
  reason: LiveMdDirtyReason,
) {
  let range = clampRange(state, { from, to });
  ranges.push({ from: range.from, reasons: new Set([reason]), to: range.to });
}

function clampRange(state: EditorState, range: Pick<LiveMdDirtyRange, "from" | "to">) {
  return {
    from: clamp(range.from, 0, state.doc.length),
    to: clamp(range.to, 0, state.doc.length),
  };
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
  let scope = match ? registry.scopeFor(match.name) : null;
  let expanded =
    match && scope
      ? expandByScope(state, range, match, scopeForDirtyRange(range, scope))
      : expandToTouchedLines(state, range);
  let clamped = clampRange(state, cover(range, expanded));
  return {
    ...clamped,
    reasons: range.reasons,
  };
}

function isSelectionOnly(range: LiveMdDirtyRange) {
  return range.reasons.length > 0 && range.reasons.every((reason) => reason == "selection");
}

function isTextOnly(range: LiveMdDirtyRange) {
  return range.reasons.length > 0 && range.reasons.every((reason) => reason == "text");
}

function scopeForTextOnlyRange(range: LiveMdDirtyRange, scope: LiveMdScope) {
  if (isTextOnly(range) && (scope == "block" || scope == "container" || scope == "document")) {
    return "line";
  }
  return scope;
}

function scopeForDirtyRange(range: LiveMdDirtyRange, scope: LiveMdScope) {
  if (isSelectionOnly(range)) return scopeForSelectionOnlyRange(scope);
  return scopeForTextOnlyRange(range, scope);
}

function scopeForSelectionOnlyRange(scope: LiveMdScope) {
  if (scope == "block" || scope == "container" || scope == "document") return "line";
  return scope;
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
  let seen = new Set<string>();
  for (let boundary of dirtyBoundaries(state, range)) {
    for (
      let current: SyntaxNodeIterator | null = syntaxTree(state).resolveStack(
        boundary.pos,
        boundary.side,
      );
      current;
      current = current.next
    ) {
      let node = current.node;
      let key = `${node.name}:${node.from}:${node.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (
        !registry.hasNode(node.name) ||
        !touches(node.from, node.to, boundary.from, boundary.to)
      ) {
        continue;
      }
      if (!found || node.to - node.from < found.to - found.from) found = node;
    }
  }
  return found;
}

function dirtyBoundaries(
  state: EditorState,
  range: Pick<LiveMdDirtyRange, "from" | "to">,
): DirtyBoundary[] {
  let from = clamp(range.from, 0, state.doc.length);
  let to = clamp(range.to, 0, state.doc.length);
  if (from == to) {
    let boundaries: DirtyBoundary[] = [{ from, pos: from, side: 0, to }];
    let next = nextNonWhitespace(state, from);
    if (next < state.doc.length) {
      boundaries.push({ from: next, pos: next, side: 1, to: next + 1 });
    }
    let previous = previousNonWhitespace(state, from);
    if (previous >= 0) {
      boundaries.push({ from: previous, pos: previous, side: 1, to: previous + 1 });
    }
    return boundaries;
  }
  return [
    { from, pos: from, side: 1, to },
    { from, pos: to, side: -1, to },
  ];
}

function nextNonWhitespace(state: EditorState, from: number) {
  for (let pos = from; pos < state.doc.length; pos++) {
    if (!/\s/u.test(state.sliceDoc(pos, pos + 1))) return pos;
  }
  return state.doc.length;
}

function previousNonWhitespace(state: EditorState, from: number) {
  for (let pos = Math.min(from - 1, state.doc.length - 1); pos >= 0; pos--) {
    if (!/\s/u.test(state.sliceDoc(pos, pos + 1))) return pos;
  }
  return -1;
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

function addReason(map: Map<string, LiveMdDirtyReason[]>, key: string, reason: LiveMdDirtyReason) {
  let reasons = map.get(key);
  if (!reasons) {
    map.set(key, [reason]);
    return;
  }
  if (!reasons.includes(reason)) reasons.push(reason);
}
