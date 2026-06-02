import {
  type ChangeDesc,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  StateField,
} from "@codemirror/state";
import {
  rangesTouch,
  syntaxTree,
  syntaxTreeChangedRanges,
  TreeSitterParser,
  type SyntaxNode,
  type Tree,
  type TreeSitterQuery,
} from "@codemirror-treesitter/language";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import {
  collectLiveMdDirtyRanges,
  type LiveMdDirtyRange,
  type LiveMdDirtyReason,
} from "./dirty-ranges.js";
import { codeFenceLanguagesField } from "./languages.js";
import { liveMdLinkBaseUrl, liveMdLinkMark } from "./links.js";
import { forEachLineInRange, isWhitespace, isWhitespaceOnly } from "./util.js";
import {
  ImagePreviewWidget,
  LatexWidget,
  ListMarkerWidget,
  MermaidWidget,
  TablePreviewWidget,
  TaskCheckboxWidget,
  type LatexFormula,
  type MarkdownTable,
  type MermaidDiagram,
} from "./widgets.js";

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
    let previousActiveLines = transaction.selection ? Array.from(value.activeLines) : undefined;
    let newDirtyRanges = collectLiveMdDirtyRanges({
      activeLines: transaction.selection ? Array.from(activeLines) : undefined,
      changes: transaction.changes,
      startState: transaction.startState,
      state: transaction.state,
      syntaxChangedRanges,
    });
    let oldDirtyRanges = collectOldLiveMdDirtyRanges(
      transaction.startState,
      transaction.changes,
      syntaxChangedRanges,
      previousActiveLines,
    );
    if (codeFenceLanguageUpdate && !newDirtyRanges.length && !oldDirtyRanges.length) {
      newDirtyRanges = [
        {
          from: 0,
          reasons: ["syntax"],
          to: transaction.state.doc.length,
        },
      ];
      oldDirtyRanges = [
        {
          from: 0,
          reasons: ["syntax"],
          to: transaction.startState.doc.length,
        },
      ];
    }
    return patchLiveMdAnalysis(
      value,
      transaction.startState,
      transaction.state,
      transaction.changes,
      oldDirtyRanges,
      newDirtyRanges,
      activeLines,
    );
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
  | "gap"
  | "heading"
  | "image"
  | "inline"
  | "latex"
  | "link"
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

class OwnedAtomicRange extends RangeValue {
  constructor(readonly ownerId: number) {
    super();
  }

  eq(other: RangeValue) {
    return other instanceof OwnedAtomicRange && other.ownerId == this.ownerId;
  }
}

type OwnerOutputRange<T extends RangeValue> = {
  from: number;
  to: number;
  value: T;
};

type OwnerBuildResult = {
  atomicRanges: RangeSet<RangeValue>;
  atomicRangeValues: OwnerOutputRange<RangeValue>[];
  decorations: DecorationSet;
  decorationRanges: OwnerOutputRange<Decoration>[];
  nextOwnerId: number;
  owners: RangeSet<LiveMdOwner>;
  ownerRanges: OwnerOutputRange<LiveMdOwner>[];
};

function buildLiveMdAnalysis(
  state: EditorState,
  dirtyRanges: readonly LiveMdDirtyRange[],
  activeLines = getActiveLines(state),
): LiveMdAnalysis {
  let output = buildLiveMdOwnerOutput(state, activeLines, 1);
  return {
    activeLines,
    affectedRanges: [],
    atomicRanges: output.atomicRanges,
    decorations: output.decorations,
    dirtyRanges,
    nextOwnerId: output.nextOwnerId,
    owners: output.owners,
    queryRanges: [],
  };
}

export function __testBuildLiveMdAnalysis(state: EditorState) {
  return buildLiveMdAnalysis(state, []);
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
const liveMdInlineOwnerQuerySource = `
  (image) @image
  (inline_link) @link
  (uri_autolink) @link
  (latex_block) @latex
  (code_span) @inline
  (emphasis) @inline
  (strong_emphasis) @inline
  (strikethrough) @inline
`;

const liveMdInlineOwnerQueries = new WeakMap<TreeSitterParser, TreeSitterQuery>();

function buildLiveMdOwnerOutput(
  state: EditorState,
  activeLines: ReadonlySet<number>,
  nextOwnerId: number,
  ranges?: readonly LiveMdDirtyRange[],
): OwnerBuildResult {
  let tree = syntaxTree(state);
  let query = liveMdOwnerQuery(tree);
  let output = new OwnerOutputPlan(state, activeLines);
  if (!query) return output.finish(nextOwnerId);

  let seen = new Set<string>();
  let queryCaptures = capturesForRanges(query, tree, ranges);
  for (let capture of [...queryCaptures, ...inlineOwnerCaptures(tree, ranges)]) {
    let captureKind = liveMdOwnerKind(capture.name);
    if (!captureKind) continue;
    let range = liveMdOwnerRange(state, capture.node, captureKind);
    let key = `${captureKind}:${range.from}:${range.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let owner = new LiveMdOwner(nextOwnerId++, captureKind);
    output.owner(range.from, range.to, owner);
    renderLiveMdOwner(output, capture.node, owner);
  }
  nextOwnerId = renderParagraphGapOwners(output, tree, nextOwnerId, ranges);
  return output.finish(nextOwnerId);
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

function liveMdInlineOwnerQuery(tree: Tree) {
  let parser = tree.config instanceof TreeSitterParser ? tree.config : null;
  if (!parser || !tree.tree) return null;
  let query = liveMdInlineOwnerQueries.get(parser);
  if (!query) {
    query = parser.query(liveMdInlineOwnerQuerySource);
    liveMdInlineOwnerQueries.set(parser, query);
  }
  return query;
}

function capturesForRanges(
  query: TreeSitterQuery,
  tree: Tree,
  ranges: readonly LiveMdDirtyRange[] | undefined,
) {
  if (!ranges?.length) return query.captures(tree);
  return ranges.flatMap((range) => {
    let options = queryWindowOptions(tree, range);
    return options ? query.captures(tree, options) : [];
  });
}

function inlineOwnerCaptures(tree: Tree, ranges: readonly LiveMdDirtyRange[] | undefined) {
  return tree.nested.flatMap((nested) => {
    let query = liveMdInlineOwnerQuery(nested.tree);
    return query ? capturesForRanges(query, nested.tree, ranges) : [];
  });
}

function liveMdOwnerKind(name: string): LiveMdOwnerKind | null {
  switch (name) {
    case "blockquote":
    case "heading":
    case "image":
    case "inline":
    case "latex":
    case "link":
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
  if (kind == "heading" || kind == "image" || kind == "paragraph" || kind == "rule") {
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
    expanded.push({
      from: first.from,
      reasons: range.reasons,
      to: Math.min(state.doc.length, last.to + 1),
    });
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
    let options = queryWindowOptions(tree, queryRange);
    if (!options) continue;
    for (let capture of query.captures(tree, options)) {
      let kind = liveMdOwnerKind(capture.name);
      if (!kind) continue;
      let ownerRange = liveMdAffectedOwnerRange(state, capture.node, kind, dirtyRange);
      if (!ownerRange) continue;
      ownerRanges.push({ ...ownerRange, reasons: dirtyRange.reasons });
    }
  }

  return mergeLiveMdRanges(ownerRanges);
}

function queryWindowOptions(tree: Tree, range: Pick<LiveMdDirtyRange, "from" | "to">) {
  let root = tree.topNode;
  let from = Math.max(root.from, range.from - 1);
  let to = Math.min(root.to, range.to + 1);
  if (from > to) return null;
  return {
    from,
    to,
  };
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
    case "blockquote":
    case "image":
    case "inline":
    case "latex":
    case "link":
    case "list":
    case "paragraph":
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

function collectOldLiveMdDirtyRanges(
  startState: EditorState,
  changes: ChangeDesc,
  syntaxChangedRanges: readonly Pick<LiveMdDirtyRange, "from" | "to">[],
  previousActiveLines: readonly number[] | undefined,
) {
  let ranges: LiveMdDirtyRange[] = [];
  changes.iterChangedRanges((from, to) => {
    ranges.push({ from, reasons: ["text"], to });
  });
  ranges.push(...mapLiveMdRanges(changes.invertedDesc, syntaxChangedRanges, ["syntax"]));
  for (let lineNumber of previousActiveLines ?? []) {
    let range = lineDirtyRange(startState, lineNumber, "selection");
    if (range) ranges.push(range);
  }
  return mergeLiveMdRanges(ranges);
}

function lineDirtyRange(
  state: EditorState,
  lineNumber: number,
  reason: LiveMdDirtyReason,
): LiveMdDirtyRange | null {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return null;
  let line = state.doc.line(lineNumber);
  return { from: line.from, reasons: [reason], to: line.to };
}

function mapLiveMdRanges(
  changes: ChangeDesc,
  ranges: readonly (Pick<LiveMdDirtyRange, "from" | "to"> &
    Partial<Pick<LiveMdDirtyRange, "reasons">>)[],
  fallbackReasons?: readonly LiveMdDirtyReason[],
) {
  return mergeLiveMdRanges(
    ranges.map((range) => {
      let sourceFrom = clamp(range.from, 0, changes.length);
      let sourceTo = clamp(range.to, 0, changes.length);
      let from = changes.mapPos(sourceFrom, 1);
      let to = changes.mapPos(sourceTo, -1);
      return {
        from: Math.min(from, to),
        reasons: range.reasons ?? fallbackReasons ?? [],
        to: Math.max(from, to),
      };
    }),
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampPosition(state: EditorState, pos: number) {
  return Math.min(state.doc.length, Math.max(0, pos));
}

function patchLiveMdAnalysis(
  previous: LiveMdAnalysis,
  startState: EditorState,
  state: EditorState,
  changes: ChangeDesc,
  oldDirtyRanges: readonly LiveMdDirtyRange[],
  newDirtyRanges: readonly LiveMdDirtyRange[],
  activeLines: Set<number>,
): LiveMdAnalysis {
  let oldQueryRanges = liveMdQueryRanges(startState, oldDirtyRanges);
  let newQueryRanges = liveMdQueryRanges(state, newDirtyRanges);
  let mappedOldQueryRanges = mapLiveMdRanges(changes, oldQueryRanges);
  let queryRanges = mergeLiveMdRanges([...mappedOldQueryRanges, ...newQueryRanges]);
  let oldAffectedRanges = liveMdAffectedRanges(startState, oldDirtyRanges, oldQueryRanges);
  let newAffectedRanges = liveMdAffectedRanges(state, newDirtyRanges, newQueryRanges);
  let mappedOldAffectedRanges = mapLiveMdRanges(changes, oldAffectedRanges);
  let affectedRanges = mergeLiveMdRanges([...mappedOldAffectedRanges, ...newAffectedRanges]);
  let dirtyRanges = mergeLiveMdRanges([
    ...mapLiveMdRanges(changes, oldDirtyRanges),
    ...newDirtyRanges,
  ]);
  let mappedOwners = previous.owners.map(changes);
  let refreshRanges = mergeLiveMdRanges([...affectedRanges, ...queryRanges]);
  let invalidOwnerIds = ownerIdsTouching(mappedOwners, refreshRanges);
  let additions = buildLiveMdOwnerOutput(state, activeLines, previous.nextOwnerId, refreshRanges);
  return {
    activeLines,
    affectedRanges,
    atomicRanges: patchAtomicRanges(
      previous.atomicRanges.map(changes),
      invalidOwnerIds,
      additions.atomicRangeValues,
    ),
    decorations: patchDecorationSet(
      previous.decorations.map(changes),
      invalidOwnerIds,
      additions.decorationRanges,
    ),
    dirtyRanges,
    nextOwnerId: additions.nextOwnerId,
    owners: patchOwners(mappedOwners, invalidOwnerIds, additions.ownerRanges),
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

class OwnerOutputPlan {
  private atomicRanges: OwnerOutputRange<RangeValue>[] = [];
  private decorationRanges: OwnerOutputRange<Decoration>[] = [];
  private lineClasses = new Map<number, { classes: Set<string>; ownerIds: Set<number> }>();
  private ownerRanges: OwnerOutputRange<LiveMdOwner>[] = [];

  constructor(
    readonly state: EditorState,
    readonly activeLines: ReadonlySet<number>,
  ) {}

  owner(from: number, to: number, owner: LiveMdOwner) {
    let range = this.clampRange(from, to);
    this.ownerRanges.push({ ...range, value: owner });
  }

  line(lineNumber: number, className: string, ownerId: number) {
    if (lineNumber < 1 || lineNumber > this.state.doc.lines) return;
    let line = this.lineClasses.get(lineNumber);
    if (!line) {
      line = { classes: new Set(), ownerIds: new Set() };
      this.lineClasses.set(lineNumber, line);
    }
    line.classes.add(className);
    line.ownerIds.add(ownerId);
  }

  lineClass(from: number, to: number, className: string, ownerId: number) {
    forEachLineInRange(this.state, from, to, (line) => this.line(line.number, className, ownerId));
  }

  atom(from: number, to: number, ownerId: number) {
    let range = this.clampRange(from, to);
    if (range.from < range.to) {
      this.atomicRanges.push({ ...range, value: new OwnedAtomicRange(ownerId) });
    }
  }

  mark(from: number, to: number, decoration: Decoration, ownerId: number) {
    let range = this.clampRange(from, to);
    if (range.from < range.to) {
      this.decorationRanges.push({
        ...range,
        value: cloneDecorationWithOwner(decoration, ownerId),
      });
    }
  }

  replace(from: number, to: number, widget: WidgetType, ownerId: number, block = false) {
    let range = this.clampRange(from, to);
    if (range.from < range.to) {
      this.decorationRanges.push({
        ...range,
        value: Decoration.replace({ block, liveMdOwnerId: ownerId, widget }),
      });
    }
  }

  syntax(from: number, to: number, ownerId: number, decoration?: Decoration) {
    ({ from, to } = this.clampRange(from, to));
    if (from >= to) return;
    splitRangeByStateLine(this.state, from, to, (lineNumber, rangeFrom, rangeTo) => {
      let mark =
        decoration ??
        Decoration.mark({
          class: this.activeLines.has(lineNumber)
            ? "cm-md-syntax cm-md-syntax-active"
            : "cm-md-syntax cm-md-syntax-hidden",
        });
      this.mark(rangeFrom, rangeTo, mark, ownerId);
    });
  }

  finish(nextOwnerId: number): OwnerBuildResult {
    let decorationRanges = this.finishDecorationRanges();
    let atomicRangeValues = this.sorted(this.atomicRanges);
    let ownerRanges = this.sorted(this.ownerRanges);
    return {
      atomicRanges: this.rangeSet(atomicRangeValues),
      atomicRangeValues,
      decorations: Decoration.set(decorationRanges, true),
      decorationRanges,
      nextOwnerId,
      owners: this.rangeSet(ownerRanges),
      ownerRanges,
    };
  }

  private finishDecorationRanges() {
    let decorations = [...this.decorationRanges];
    for (let [lineNumber, lineClass] of this.lineClasses) {
      let line = this.state.doc.line(lineNumber);
      decorations.push({
        from: line.from,
        to: line.from,
        value: Decoration.line({
          class: [...lineClass.classes].join(" "),
          liveMdOwnerIds: [...lineClass.ownerIds],
        }),
      });
    }
    return this.sorted(decorations);
  }

  private sorted<T extends RangeValue>(ranges: OwnerOutputRange<T>[]) {
    return ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  }

  private rangeSet<T extends RangeValue>(ranges: OwnerOutputRange<T>[]) {
    let builder = new RangeSetBuilder<T>();
    for (let range of ranges) builder.add(range.from, range.to, range.value);
    return builder.finish();
  }

  private clampRange(from: number, to: number) {
    return {
      from: clampPosition(this.state, from),
      to: clampPosition(this.state, to),
    };
  }
}

function renderLiveMdOwner(plan: OwnerOutputPlan, node: SyntaxNode, owner: LiveMdOwner) {
  switch (owner.kind) {
    case "heading":
      renderHeadingOwner(plan, node, owner.id);
      break;
    case "blockquote":
      renderBlockquoteOwner(plan, node, owner.id);
      break;
    case "list":
      renderListOwner(plan, node, owner.id);
      break;
    case "rule":
      renderRuleOwner(plan, node, owner.id);
      break;
    case "link":
      renderLinkOwner(plan, node, owner.id);
      break;
    case "image":
      renderImageOwner(plan, node, owner.id);
      break;
    case "latex":
      renderLatexOwner(plan, node, owner.id);
      break;
    case "table":
      renderTableOwner(plan, node, owner.id);
      break;
    case "codeFence":
      renderCodeFenceOwner(plan, node, owner.id);
      break;
    case "inline":
      renderInlineOwner(plan, node, owner.id);
      break;
    case "paragraph":
    case "codeFenceContent":
      break;
  }
}

function renderHeadingOwner(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  let marker = node.children.find((child) => child.name.startsWith("atx_h"));
  let underline = node.children.find((child) => child.name.startsWith("setext_h"));
  let level = marker
    ? Number(marker.name.at(5)) || 1
    : underline?.name == "setext_h2_underline"
      ? 2
      : 1;
  plan.lineClass(node.from, node.to, "cm-md-heading", ownerId);
  plan.lineClass(node.from, node.to, `cm-md-heading-${level}`, ownerId);
  if (marker) plan.syntax(marker.from, marker.to, ownerId);
  if (underline) plan.syntax(underline.from, underline.to, ownerId);
}

function renderBlockquoteOwner(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  plan.lineClass(node.from, node.to, "cm-md-blockquote", ownerId);
  forEachDescendant(node, (child) => {
    if (child.name == "block_quote_marker") plan.syntax(child.from, child.to, ownerId);
  });
}

function renderListOwner(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  forEachDescendant(node, (child) => {
    if (child.name == "list_item") plan.lineClass(child.from, child.to, "cm-md-list-line", ownerId);
    if (isListMarkerNode(child)) renderListMarker(plan, child, ownerId);
    if (child.name == "task_list_marker_checked" || child.name == "task_list_marker_unchecked") {
      renderTaskMarker(plan, child, ownerId);
    }
  });
}

function renderListMarker(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  let line = plan.state.doc.lineAt(node.from);
  plan.line(line.number, "cm-md-list-line", ownerId);
  if (plan.activeLines.has(line.number)) {
    plan.syntax(node.from, node.to, ownerId);
  } else {
    plan.replace(
      node.from,
      node.to,
      new ListMarkerWidget(plan.state.sliceDoc(node.from, node.to).trim()),
      ownerId,
    );
  }
}

function renderTaskMarker(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  let line = plan.state.doc.lineAt(node.from);
  let checked = node.name == "task_list_marker_checked";
  plan.line(line.number, "cm-md-list-line", ownerId);
  plan.line(line.number, "cm-md-task-line", ownerId);
  if (checked) plan.line(line.number, "is-checked", ownerId);
  plan.replace(node.from, node.to, new TaskCheckboxWidget(checked), ownerId);
}

function renderRuleOwner(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  plan.lineClass(node.from, node.to, "cm-md-rule-line", ownerId);
  plan.syntax(node.from, node.to, ownerId);
}

function renderLinkOwner(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  if (node.name == "uri_autolink") {
    if (node.to - node.from <= 2) return;
    plan.syntax(node.from, node.from + 1, ownerId);
    plan.mark(
      node.from + 1,
      node.to - 1,
      liveMdLinkMark(
        plan.state.sliceDoc(node.from + 1, node.to - 1),
        plan.state.facet(liveMdLinkBaseUrl),
      ),
      ownerId,
    );
    plan.syntax(node.to - 1, node.to, ownerId);
    return;
  }

  let text = node.getChild("link_text");
  let destination = node.getChild("link_destination");
  if (!text) return;
  plan.syntax(node.from, text.from, ownerId);
  plan.mark(
    text.from,
    text.to,
    liveMdLinkMark(
      destination ? plan.state.sliceDoc(destination.from, destination.to) : null,
      plan.state.facet(liveMdLinkBaseUrl),
    ),
    ownerId,
  );
  plan.syntax(text.to, node.to, ownerId);
}

function renderImageOwner(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  let description = node.getChild("image_description");
  let destination = node.getChild("link_destination");
  let alt = description ? plan.state.sliceDoc(description.from, description.to) : "";
  let src = destination ? plan.state.sliceDoc(destination.from, destination.to).trim() : "";
  if (!src) return;

  let line = plan.state.doc.lineAt(node.from);
  let active = plan.activeLines.has(line.number);
  let widget = new ImagePreviewWidget(alt, normalizeImageSource(src));
  if (!active && isOnlyVisibleContentOnLine(plan.state, line.from, line.to, node.from, node.to)) {
    plan.replace(line.from, line.to, widget, ownerId, true);
    return;
  }

  if (!active) {
    plan.replace(node.from, node.to, widget, ownerId);
    return;
  }

  if (description) {
    plan.syntax(node.from, description.from, ownerId);
    plan.mark(
      description.from,
      description.to,
      liveMdLinkMark(null, plan.state.facet(liveMdLinkBaseUrl)),
      ownerId,
    );
    plan.syntax(description.to, node.to, ownerId);
  }
}

function renderLatexOwner(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  let formula = readLatexFormula(plan.state, node);
  if (!formula || rangeTouchesActiveLine(plan.state, plan.activeLines, node.from, node.to)) return;

  let range = latexReplacementRange(plan.state, node, formula.displayMode);
  plan.replace(
    range.from,
    range.to,
    new LatexWidget({ ...formula, block: range.block }),
    ownerId,
    range.block,
  );
}

function renderTableOwner(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  let table = readTableFromNode(plan.state, node);
  if (table && !rangeTouchesActiveLine(plan.state, plan.activeLines, node.from, node.to)) {
    plan.replace(node.from, node.to, new TablePreviewWidget(table), ownerId, true);
    return;
  }

  let delimiterNode = node.getChild("pipe_table_delimiter_row");
  plan.lineClass(node.from, node.to, "cm-md-table-line", ownerId);
  if (delimiterNode)
    plan.lineClass(delimiterNode.from, delimiterNode.to, "cm-md-table-divider", ownerId);
  forEachDescendant(node, (child) => {
    if (child.name == "|") {
      plan.syntax(child.from, child.to, ownerId, Decoration.mark({ class: "cm-md-table-pipe" }));
    }
  });
}

function renderCodeFenceOwner(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  let delimiters = node.children.filter((child) => child.name == "fenced_code_block_delimiter");
  let openingDelimiter = delimiters[0];
  if (!openingDelimiter) return;

  let closingDelimiter = delimiters[1] ?? null;
  let content = node.getChild("code_fence_content");
  let language = readFenceLanguage(plan.state, node);

  if (content && content.from < content.to) {
    let diagram = readMermaidDiagram(plan.state, content, language);
    if (diagram && !rangeTouchesActiveLine(plan.state, plan.activeLines, node.from, node.to)) {
      plan.replace(node.from, node.to, new MermaidWidget(diagram), ownerId, true);
      return;
    }
  }

  let openingLineNumber = plan.state.doc.lineAt(openingDelimiter.from).number;
  let blockEndLineNumber = openingLineNumber;
  plan.line(openingLineNumber, "cm-md-code-fence-line", ownerId);
  plan.line(openingLineNumber, "cm-md-code-block-start", ownerId);
  plan.syntax(openingDelimiter.from, openingDelimiter.to, ownerId);

  if (content && content.from < content.to) {
    forEachLineInRange(plan.state, content.from, content.to, (line) => {
      plan.line(line.number, "cm-md-code-line", ownerId);
      blockEndLineNumber = line.number;
    });
  }

  if (closingDelimiter) {
    let closingLineNumber = plan.state.doc.lineAt(closingDelimiter.from).number;
    blockEndLineNumber = closingLineNumber;
    plan.line(closingLineNumber, "cm-md-code-fence-line", ownerId);
    plan.syntax(closingDelimiter.from, closingDelimiter.to, ownerId);
  }

  plan.line(blockEndLineNumber, "cm-md-code-block-end", ownerId);
}

function renderInlineOwner(plan: OwnerOutputPlan, node: SyntaxNode, ownerId: number) {
  switch (node.name) {
    case "code_span":
      plan.mark(node.from, node.to, Decoration.mark({ class: "cm-md-inline-code" }), ownerId);
      forEachDescendant(node, (child) => {
        if (child.name == "code_span_delimiter") plan.syntax(child.from, child.to, ownerId);
      });
      break;
    case "emphasis":
      plan.mark(node.from, node.to, Decoration.mark({ class: "cm-md-emphasis" }), ownerId);
      markDescendantSyntax(plan, node, ownerId, "emphasis_delimiter");
      break;
    case "strong_emphasis":
      plan.mark(node.from, node.to, Decoration.mark({ class: "cm-md-strong" }), ownerId);
      markDescendantSyntax(plan, node, ownerId, "emphasis_delimiter");
      break;
    case "strikethrough":
      plan.mark(node.from, node.to, Decoration.mark({ class: "cm-md-strike" }), ownerId);
      break;
  }
}

function renderParagraphGapOwners(
  plan: OwnerOutputPlan,
  tree: Tree,
  nextOwnerId: number,
  ranges: readonly LiveMdDirtyRange[] | undefined,
) {
  let seen = new Set<string>();
  tree.topNode.iterate((node) => {
    if (!isBlockContainerNode(node)) return;
    let children = blockGapChildren(node);
    for (let index = 1; index < children.length; index++) {
      let previous = children[index - 1]!;
      let current = children[index]!;
      nextOwnerId = renderParagraphGapOwner(
        plan,
        blockBreakFrom(plan.state, previous),
        current.from,
        nextOwnerId,
        ranges,
        seen,
      );
    }
    let last = children[children.length - 1];
    if (last) {
      nextOwnerId = renderParagraphGapOwner(
        plan,
        blockBreakFrom(plan.state, last),
        node.to,
        nextOwnerId,
        ranges,
        seen,
      );
    }
  });
  return nextOwnerId;
}

function renderParagraphGapOwner(
  plan: OwnerOutputPlan,
  from: number,
  to: number,
  nextOwnerId: number,
  ranges: readonly LiveMdDirtyRange[] | undefined,
  seen: Set<string>,
) {
  from = clampPosition(plan.state, from);
  to = clampPosition(plan.state, to);
  if (from >= to || !rangeTouchesAny(from, to, ranges)) return nextOwnerId;

  let gap = plan.state.sliceDoc(from, to);
  if (!isWhitespaceOnly(gap)) return nextOwnerId;

  let newlineOffsets = newlineOffsetsInRange(gap, from);
  if (newlineOffsets.length < 2) return nextOwnerId;

  let key = `${from}:${to}`;
  if (seen.has(key)) return nextOwnerId;
  seen.add(key);

  let owner = new LiveMdOwner(nextOwnerId++, "gap");
  plan.owner(from, to, owner);
  for (let index = 0; index + 1 < newlineOffsets.length; index += 2) {
    let pairFrom = newlineOffsets[index]!;
    let pairTo = newlineOffsets[index + 1]! + 1;
    plan.atom(pairFrom, pairTo, owner.id);
    plan.line(
      plan.state.doc.lineAt(newlineOffsets[index + 1]!).number,
      "cm-md-block-separator",
      owner.id,
    );
  }
  return nextOwnerId;
}

function isBlockContainerNode(node: SyntaxNode) {
  switch (node.name) {
    case "document":
    case "section":
    case "block_quote":
    case "list":
    case "list_item":
      return true;
    default:
      return false;
  }
}

function blockGapChildren(node: SyntaxNode) {
  return node.children.filter((child) =>
    node.name == "list" ? child.name == "list_item" : isBlockSiblingNode(child),
  );
}

function isBlockSiblingNode(node: SyntaxNode) {
  switch (node.name) {
    case "atx_heading":
    case "block_quote":
    case "fenced_code_block":
    case "html_block":
    case "indented_code_block":
    case "link_reference_definition":
    case "list":
    case "minus_metadata":
    case "paragraph":
    case "pipe_table":
    case "plus_metadata":
    case "section":
    case "setext_heading":
    case "thematic_break":
      return true;
    default:
      return false;
  }
}

function blockBreakFrom(state: EditorState, node: SyntaxNode): number {
  let children = blockGapChildren(node);
  let last = children[children.length - 1];
  if (last && last.to <= node.to) return blockBreakFrom(state, last);
  if (node.to > node.from && node.to <= state.doc.length) {
    if (state.sliceDoc(node.to - 1, node.to) == "\n") return node.to - 1;
  }
  return node.to;
}

function rangeTouchesAny(
  from: number,
  to: number,
  ranges: readonly LiveMdDirtyRange[] | undefined,
) {
  return !ranges?.length || ranges.some((range) => rangesTouch(from, to, range.from, range.to));
}

function newlineOffsetsInRange(text: string, offset: number) {
  let offsets: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) == 10) offsets.push(offset + index);
  }
  return offsets;
}

function markDescendantSyntax(
  plan: OwnerOutputPlan,
  node: SyntaxNode,
  ownerId: number,
  nodeName: string,
) {
  forEachDescendant(node, (child) => {
    if (child.name == nodeName) plan.syntax(child.from, child.to, ownerId);
  });
}

function ownerIdsTouching(owners: RangeSet<LiveMdOwner>, ranges: readonly LiveMdDirtyRange[]) {
  let ids = new Set<number>();
  if (!ranges.length) return ids;
  for (let range of ranges) {
    owners.between(range.from, range.to, (from, to, owner) => {
      if (rangesTouch(from, to, range.from, range.to)) ids.add(owner.id);
    });
  }
  return ids;
}

function patchDecorationSet(
  previous: DecorationSet,
  invalidOwnerIds: ReadonlySet<number>,
  additions: OwnerOutputRange<Decoration>[],
) {
  if (!invalidOwnerIds.size && !additions.length) return previous;
  let ranges: OwnerOutputRange<Decoration>[] = [];
  previous.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    if (!decorationHasInvalidOwner(value, invalidOwnerIds)) ranges.push({ from, to, value });
  });
  ranges.push(...additions);
  return Decoration.set(sortRanges(ranges), true);
}

function patchAtomicRanges(
  previous: RangeSet<RangeValue>,
  invalidOwnerIds: ReadonlySet<number>,
  additions: OwnerOutputRange<RangeValue>[],
) {
  if (!invalidOwnerIds.size && !additions.length) return previous;
  let ranges: OwnerOutputRange<RangeValue>[] = [];
  previous.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    if (!(value instanceof OwnedAtomicRange) || !invalidOwnerIds.has(value.ownerId)) {
      ranges.push({ from, to, value });
    }
  });
  ranges.push(...additions);
  return buildRangeSet(sortRanges(ranges));
}

function patchOwners(
  previous: RangeSet<LiveMdOwner>,
  invalidOwnerIds: ReadonlySet<number>,
  additions: OwnerOutputRange<LiveMdOwner>[],
) {
  if (!invalidOwnerIds.size && !additions.length) return previous;
  let ranges: OwnerOutputRange<LiveMdOwner>[] = [];
  previous.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    if (!invalidOwnerIds.has(value.id)) ranges.push({ from, to, value });
  });
  ranges.push(...additions);
  return buildRangeSet(sortRanges(ranges));
}

function decorationHasInvalidOwner(value: Decoration, invalidOwnerIds: ReadonlySet<number>) {
  let spec = decorationSpec(value);
  let ownerId = spec.liveMdOwnerId;
  if (typeof ownerId == "number" && invalidOwnerIds.has(ownerId)) return true;
  let ownerIds = spec.liveMdOwnerIds;
  return Array.isArray(ownerIds) && ownerIds.some((id) => invalidOwnerIds.has(id));
}

function cloneDecorationWithOwner(decoration: Decoration, ownerId: number) {
  return Decoration.mark({ ...decorationSpec(decoration), liveMdOwnerId: ownerId });
}

function decorationSpec(decoration: Decoration) {
  return (decoration as Decoration & { spec: Record<string, unknown> }).spec;
}

function sortRanges<T extends RangeValue>(ranges: OwnerOutputRange<T>[]) {
  return ranges.sort((left, right) => left.from - right.from || left.to - right.to);
}

function buildRangeSet<T extends RangeValue>(ranges: OwnerOutputRange<T>[]) {
  let builder = new RangeSetBuilder<T>();
  for (let range of ranges) builder.add(range.from, range.to, range.value);
  return builder.finish();
}

function splitRangeByStateLine(
  state: EditorState,
  from: number,
  to: number,
  visit: (lineNumber: number, from: number, to: number) => void,
) {
  let cursor = from;
  while (cursor < to) {
    let line = state.doc.lineAt(cursor);
    let rangeTo = Math.min(to, line.to);
    if (cursor < rangeTo) visit(line.number, cursor, rangeTo);
    cursor = line.to < to ? line.to + 1 : to;
  }
}

function isListMarkerNode(node: SyntaxNode) {
  switch (node.name) {
    case "list_marker_dot":
    case "list_marker_minus":
    case "list_marker_parenthesis":
    case "list_marker_plus":
    case "list_marker_star":
      return true;
    default:
      return false;
  }
}

function readLatexFormula(
  state: EditorState,
  node: SyntaxNode,
): Omit<LatexFormula, "block"> | null {
  let delimiters = node.children.filter((child) => child.name == "latex_span_delimiter");
  let openingDelimiter = delimiters[0];
  let closingDelimiter = delimiters[delimiters.length - 1];
  if (!openingDelimiter || !closingDelimiter || openingDelimiter == closingDelimiter) return null;

  let source = state.sliceDoc(node.from, node.to);
  let opening = state.sliceDoc(openingDelimiter.from, openingDelimiter.to);
  let closing = state.sliceDoc(closingDelimiter.from, closingDelimiter.to);
  let tex = state.sliceDoc(openingDelimiter.to, closingDelimiter.from).trim();
  if (!tex) return null;

  return {
    displayMode: opening.length > 1 || closing.length > 1 || tex.includes("\n"),
    source,
    tex,
  };
}

function latexReplacementRange(state: EditorState, node: SyntaxNode, displayMode: boolean) {
  if (!displayMode) return { block: false, from: node.from, to: node.to };

  let firstLine = state.doc.lineAt(node.from);
  let lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1));
  if (
    isWhitespaceOnly(state.sliceDoc(firstLine.from, node.from)) &&
    isWhitespaceOnly(state.sliceDoc(node.to, lastLine.to))
  ) {
    return { block: true, from: firstLine.from, to: lastLine.to };
  }

  return { block: false, from: node.from, to: node.to };
}

function readTableFromNode(state: EditorState, node: SyntaxNode): MarkdownTable | null {
  let headerNode = node.getChild("pipe_table_header");
  let delimiterNode = node.getChild("pipe_table_delimiter_row");
  if (!headerNode || !delimiterNode) return null;

  let header = tableCellsFromNode(state, headerNode, "pipe_table_cell");
  let alignments = tableAlignmentsFromNode(delimiterNode);
  if (header.length < 2 || alignments.length < 2) return null;

  let columnCount = Math.max(header.length, alignments.length);
  return {
    alignments: normalizeTableAlignments(alignments, columnCount),
    header: normalizeTableCells(header, columnCount),
    rows: node.children
      .filter((child) => child.name == "pipe_table_row")
      .map((row) =>
        normalizeTableCells(tableCellsFromNode(state, row, "pipe_table_cell"), columnCount),
      ),
  };
}

function tableCellsFromNode(state: EditorState, node: SyntaxNode, cellName: string) {
  return node.children
    .filter((child) => child.name == cellName)
    .map((cell) => state.sliceDoc(cell.from, cell.to).trim());
}

function tableAlignmentsFromNode(node: SyntaxNode) {
  return node.children
    .filter((child) => child.name == "pipe_table_delimiter_cell")
    .map((cell): "center" | "default" | "left" | "right" => {
      let left = cell.children.some((child) => child.name == "pipe_table_align_left");
      let right = cell.children.some((child) => child.name == "pipe_table_align_right");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "default";
    });
}

function readFenceLanguage(state: EditorState, node: SyntaxNode) {
  let infoString = node.getChild("info_string");
  let languageNode = infoString?.getChild("language") ?? infoString;
  if (!languageNode) return "";
  return normalizeFenceLanguage(state.sliceDoc(languageNode.from, languageNode.to));
}

function normalizeFenceLanguage(language: string) {
  let token = firstToken(language.trim());
  if (token.startsWith("{")) token = token.slice(1);
  if (token.startsWith(".")) token = token.slice(1);
  if (token.endsWith("}")) token = token.slice(0, -1);
  return token.toLowerCase();
}

function readMermaidDiagram(
  state: EditorState,
  content: SyntaxNode,
  language: string,
): MermaidDiagram | null {
  if (!isMermaidFenceLanguage(language)) return null;
  let source = state.sliceDoc(content.from, content.to).replace(/\s+$/u, "");
  return source.trim() ? { source } : null;
}

function isMermaidFenceLanguage(language: string) {
  return language == "mermaid" || language == "mmd";
}

function firstToken(value: string) {
  for (let index = 0; index < value.length; index++) {
    if (isWhitespace(value.charCodeAt(index))) return value.slice(0, index);
  }
  return value;
}

function rangeTouchesActiveLine(
  state: EditorState,
  activeLines: ReadonlySet<number>,
  from: number,
  to: number,
) {
  let firstLine = state.doc.lineAt(from).number;
  let lastLine = state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNumber of activeLines) {
    if (lineNumber >= firstLine && lineNumber <= lastLine) return true;
  }
  return false;
}

function isOnlyVisibleContentOnLine(
  state: EditorState,
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

function normalizeImageSource(source: string) {
  return source.trim();
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

function forEachDescendant(node: SyntaxNode, callback: (node: SyntaxNode) => void) {
  for (let child of node.children) {
    callback(child);
    forEachDescendant(child, callback);
  }
}
