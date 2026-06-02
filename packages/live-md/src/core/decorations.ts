import { EditorState, RangeSet, RangeSetBuilder, RangeValue, StateField } from "@codemirror/state";
import {
  rangesTouch,
  syntaxTree,
  syntaxTreeChangedRanges,
  TreeSitterParser,
  type SyntaxNode,
  type Tree,
  type TreeSitterQuery,
} from "@codemirror-treesitter/language";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import {
  collectLiveMdDirtyRanges,
  type LiveMdDirtyRange,
  type LiveMdDirtyReason,
} from "./dirty-ranges.js";
import { codeFenceLanguagesField } from "./languages.js";

type LiveMdAnalysis = {
  activeLines: ReadonlySet<number>;
  affectedRanges: readonly LiveMdDirtyRange[];
  atomicRanges: RangeSet<RangeValue>;
  decorations: DecorationSet;
  dirtyRanges: readonly LiveMdDirtyRange[];
  nextOwnerId: number;
  owners: RangeSet<LiveMdOwner>;
  queryRanges: readonly LiveMdDirtyRange[];
};

export const liveMdAnalysis = StateField.define<LiveMdAnalysis>({
  create(state) {
    return buildLiveMdAnalysis(state, []);
  },
  update(value, transaction) {
    let codeFenceLanguageUpdate = codeFenceLanguagesChanged(
      transaction.startState,
      transaction.state,
    );
    let syntaxChangedRanges = syntaxTreeChangedRanges(transaction);
    if (
      !transaction.docChanged &&
      !transaction.selection &&
      !codeFenceLanguageUpdate &&
      !syntaxChangedRanges.length
    ) {
      return value;
    }

    let activeLines = getActiveLines(transaction.state);
    let dirtyRanges = collectLiveMdDirtyRanges({
      activeLines: transaction.selection ? Array.from(activeLines) : undefined,
      changes: transaction.changes,
      previousActiveLines: transaction.selection ? Array.from(value.activeLines) : undefined,
      startState: transaction.startState,
      state: transaction.state,
      syntaxChangedRanges,
    });
    return patchLiveMdAnalysis(value, transaction.state, dirtyRanges, activeLines);
  },
  provide(field) {
    return [
      EditorView.decorations.from(field, (analysis) => analysis.decorations),
      EditorView.atomicRanges.of(
        (view) => view.state.field(field, false)?.atomicRanges ?? RangeSet.empty,
      ),
    ];
  },
});

type LiveMdOwnerKind =
  | "blockquote"
  | "codeFence"
  | "codeFenceContent"
  | "heading"
  | "list"
  | "paragraph"
  | "rule"
  | "table";

class LiveMdOwner extends RangeValue {
  constructor(
    readonly id: number,
    readonly kind: LiveMdOwnerKind,
  ) {
    super();
  }

  eq(other: RangeValue) {
    return other instanceof LiveMdOwner && other.id == this.id && other.kind == this.kind;
  }
}

function buildLiveMdAnalysis(
  state: EditorState,
  dirtyRanges: readonly LiveMdDirtyRange[],
  activeLines = getActiveLines(state),
): LiveMdAnalysis {
  let { owners, nextOwnerId } = buildLiveMdOwners(state, 1);
  return {
    activeLines,
    affectedRanges: [],
    atomicRanges: RangeSet.empty,
    decorations: Decoration.none,
    dirtyRanges,
    nextOwnerId,
    owners,
    queryRanges: [],
  };
}

export function __testLiveMdOwnerSnapshots(analysis: LiveMdAnalysis) {
  let owners: Array<{ from: number; id: number; kind: LiveMdOwnerKind; to: number }> = [];
  analysis.owners.between(0, Number.MAX_SAFE_INTEGER, (from, to, owner) => {
    owners.push({ from, id: owner.id, kind: owner.kind, to });
  });
  return {
    affectedRanges: analysis.affectedRanges,
    owners,
    queryRanges: analysis.queryRanges,
  };
}

const liveMdOwnerQuerySource = `
  (atx_heading) @heading
  (setext_heading) @heading
  (block_quote) @blockquote
  (list) @list
  (fenced_code_block) @code_fence
  (code_fence_content) @code_fence_content
  (pipe_table) @table
  (paragraph) @paragraph
  (thematic_break) @rule
`;

const liveMdOwnerQueries = new WeakMap<TreeSitterParser, TreeSitterQuery>();

function buildLiveMdOwners(state: EditorState, nextOwnerId: number) {
  let tree = syntaxTree(state);
  let query = liveMdOwnerQuery(tree);
  let builder = new RangeSetBuilder<LiveMdOwner>();
  if (!query) return { nextOwnerId, owners: builder.finish() };

  let seen = new Set<string>();
  for (let capture of query.captures(tree)) {
    let kind = liveMdOwnerKind(capture.name);
    if (!kind) continue;
    let range = liveMdOwnerRange(state, capture.node, kind);
    let key = `${kind}:${range.from}:${range.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    builder.add(range.from, range.to, new LiveMdOwner(nextOwnerId++, kind));
  }
  return { nextOwnerId, owners: builder.finish() };
}

function liveMdOwnerQuery(tree: Tree) {
  let parser = tree.config instanceof TreeSitterParser ? tree.config : null;
  if (!parser || !tree.tree) return null;
  let query = liveMdOwnerQueries.get(parser);
  if (!query) {
    query = parser.query(liveMdOwnerQuerySource);
    liveMdOwnerQueries.set(parser, query);
  }
  return query;
}

function liveMdOwnerKind(name: string): LiveMdOwnerKind | null {
  switch (name) {
    case "blockquote":
    case "heading":
    case "list":
    case "paragraph":
    case "rule":
    case "table":
      return name;
    case "code_fence":
      return "codeFence";
    case "code_fence_content":
      return "codeFenceContent";
    default:
      return null;
  }
}

function liveMdOwnerRange(state: EditorState, node: SyntaxNode, kind: LiveMdOwnerKind) {
  if (kind == "heading" || kind == "paragraph" || kind == "rule") {
    let first = state.doc.lineAt(node.from);
    let last = state.doc.lineAt(Math.max(node.from, node.to - 1));
    return { from: first.from, to: last.to };
  }
  return { from: node.from, to: node.to };
}

function liveMdQueryRanges(
  state: EditorState,
  dirtyRanges: readonly LiveMdDirtyRange[],
): readonly LiveMdDirtyRange[] {
  let expanded: LiveMdDirtyRange[] = [];
  for (let range of dirtyRanges) {
    let fromLine = state.doc.lineAt(clampPosition(state, range.from)).number;
    let toLine = state.doc.lineAt(clampPosition(state, Math.max(range.from, range.to - 1))).number;
    let first = state.doc.line(Math.max(1, fromLine - 1));
    let last = state.doc.line(Math.min(state.doc.lines, toLine + 2));
    expanded.push({ from: first.from, reasons: range.reasons, to: last.to });
  }
  return mergeLiveMdRanges(expanded);
}

function liveMdAffectedRanges(
  state: EditorState,
  dirtyRanges: readonly LiveMdDirtyRange[],
  queryRanges: readonly LiveMdDirtyRange[],
): readonly LiveMdDirtyRange[] {
  let tree = syntaxTree(state);
  let query = liveMdOwnerQuery(tree);
  if (!query) return [];

  let ownerRanges: LiveMdDirtyRange[] = [];
  for (let dirtyRange of dirtyRanges) {
    let queryRange = queryRanges.find((range) =>
      rangesTouch(range.from, range.to, dirtyRange.from, dirtyRange.to),
    );
    if (!queryRange) continue;
    for (let capture of query.captures(tree, { from: queryRange.from, to: queryRange.to })) {
      let kind = liveMdOwnerKind(capture.name);
      if (!kind) continue;
      let ownerRange = liveMdAffectedOwnerRange(state, capture.node, kind, dirtyRange);
      if (!ownerRange) continue;
      ownerRanges.push({ ...ownerRange, reasons: dirtyRange.reasons });
    }
  }

  return mergeLiveMdRanges(ownerRanges);
}

function liveMdAffectedOwnerRange(
  state: EditorState,
  node: SyntaxNode,
  kind: LiveMdOwnerKind,
  dirtyRange: LiveMdDirtyRange,
): Pick<LiveMdDirtyRange, "from" | "to"> | null {
  switch (kind) {
    case "table":
      return { from: node.from, to: node.to };
    case "codeFence":
      return codeFenceOwnerInvalidationRange(state, node, dirtyRange);
    case "heading":
    case "rule":
      return liveMdOwnerRange(state, node, kind);
    default:
      return null;
  }
}

function codeFenceOwnerInvalidationRange(
  state: EditorState,
  node: SyntaxNode,
  dirtyRange: LiveMdDirtyRange,
): Pick<LiveMdDirtyRange, "from" | "to"> | null {
  let content = node.getChild("code_fence_content");
  if (
    content &&
    dirtyRange.from >= content.from &&
    dirtyRange.to <= codeFenceContentDirtyTo(state, content.to)
  ) {
    return null;
  }
  return { from: node.from, to: node.to };
}

function codeFenceContentDirtyTo(state: EditorState, contentTo: number) {
  if (contentTo > 0 && state.sliceDoc(contentTo - 1, contentTo) == "\n") return contentTo - 1;
  return contentTo;
}

function mergeLiveMdRanges(ranges: readonly LiveMdDirtyRange[]) {
  let sorted = ranges
    .map((range) => ({ ...range }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  let merged: LiveMdDirtyRange[] = [];
  for (let range of sorted) {
    let last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
      last.reasons = mergeReasons(last.reasons, range.reasons);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function mergeReasons(
  left: readonly LiveMdDirtyReason[],
  right: readonly LiveMdDirtyReason[],
): readonly LiveMdDirtyReason[] {
  let reasons = new Set([...left, ...right]);
  return ["text", "syntax", "selection"].filter((reason) =>
    reasons.has(reason as LiveMdDirtyReason),
  ) as readonly LiveMdDirtyReason[];
}

function clampPosition(state: EditorState, pos: number) {
  return Math.min(state.doc.length, Math.max(0, pos));
}

function patchLiveMdAnalysis(
  previous: LiveMdAnalysis,
  state: EditorState,
  dirtyRanges: readonly LiveMdDirtyRange[],
  activeLines: Set<number>,
): LiveMdAnalysis {
  let queryRanges = liveMdQueryRanges(state, dirtyRanges);
  let affectedRanges = liveMdAffectedRanges(state, dirtyRanges, queryRanges);
  let { owners, nextOwnerId } = buildLiveMdOwners(state, previous.nextOwnerId);
  return {
    activeLines,
    affectedRanges,
    atomicRanges: RangeSet.empty,
    decorations: Decoration.none,
    dirtyRanges,
    nextOwnerId,
    owners,
    queryRanges,
  };
}

function codeFenceLanguagesChanged(startState: EditorState, state: EditorState) {
  return (
    startState.field(codeFenceLanguagesField, false) != state.field(codeFenceLanguagesField, false)
  );
}

function getActiveLines(state: EditorState) {
  let lines = new Set<number>();
  for (let range of state.selection.ranges) {
    lines.add(state.doc.lineAt(range.head).number);
  }
  return lines;
}
