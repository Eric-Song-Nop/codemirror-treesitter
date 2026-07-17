import {
  EditorState,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  type ChangeDesc,
  type Extension,
  type StateEffect,
  type Transaction,
} from "@codemirror/state";
import { SearchQuery, search, searchKeymap, setSearchQuery } from "@codemirror/search";
import { syntaxTree, type SyntaxNode, type Tree } from "@codemirror-treesitter/language";
import { keymap } from "@codemirror/view";
import { forEachLeafAnalysisCacheRecord } from "./analysis/markdown-leaf-cache.js";
import { type LiveMdDescriptor } from "./analysis/descriptors.js";
import {
  liveMdMarkdownParserServiceFacet,
  withLiveMdMarkdownInlineTrees,
  withLiveMdMarkdownInlineTreesInRanges,
} from "./languages.js";
import { liveMdSearchSemanticSnapshot } from "./runtime/field.js";

type SearchTest = NonNullable<SearchQuery["test"]>;

const liveMdSearchTests = new WeakSet<SearchTest>();
const combinedSearchTests = new WeakMap<SearchTest, SearchTest>();
const visibilityIndexCache = new WeakMap<EditorState, RangeSet<HiddenSourceRange>>();

class HiddenSourceRange extends RangeValue {
  eq(other: RangeValue) {
    return other instanceof HiddenSourceRange;
  }
}

const hiddenSourceRange = new HiddenSourceRange();

export const liveMdSearch: Extension = [
  search(),
  EditorState.transactionFilter.of(addLiveMdSearchTest),
  keymap.of(searchKeymap),
];

function addLiveMdSearchTest(tr: Transaction) {
  let effects: StateEffect<unknown>[] | null = null;
  for (let effect of tr.effects) {
    if (!effect.is(setSearchQuery)) continue;
    let query = liveMdSearchQuery(effect.value);
    if (query != effect.value) (effects ??= []).push(setSearchQuery.of(query));
  }
  return effects ? [tr, { effects }] : tr;
}

function liveMdSearchQuery(query: SearchQuery) {
  let test = liveMdSearchTest(query.test);
  if (test == query.test) return query;
  return new SearchQuery({
    search: query.search,
    caseSensitive: query.caseSensitive,
    literal: query.literal,
    regexp: query.regexp,
    replace: query.replace,
    wholeWord: query.wholeWord,
    test,
  });
}

function liveMdSearchTest(test: SearchQuery["test"]): SearchTest {
  if (!test) return liveMdMarkdownSearchTest;
  if (liveMdSearchTests.has(test)) return test;
  let combined = combinedSearchTests.get(test);
  if (!combined) {
    combined = (match, state, from, to) =>
      test(match, state, from, to) && isLiveMdSearchVisible(state, from, to);
    liveMdSearchTests.add(combined);
    combinedSearchTests.set(test, combined);
  }
  return combined;
}

const liveMdMarkdownSearchTest: SearchTest = (_match, state, from, to) =>
  isLiveMdSearchVisible(state, from, to);

liveMdSearchTests.add(liveMdMarkdownSearchTest);

export function __testIsLiveMdSearchVisible(state: EditorState, from: number, to: number) {
  return isLiveMdSearchVisible(state, from, to);
}

function isLiveMdSearchVisible(state: EditorState, from: number, to: number) {
  if (from >= to) return true;
  let hidden = false;
  liveMdSearchVisibilityIndex(state).between(from, to, (hiddenFrom, hiddenTo) => {
    if (hiddenFrom < to && from < hiddenTo) hidden = true;
  });
  return !hidden;
}

function liveMdSearchVisibilityIndex(state: EditorState) {
  let cached = visibilityIndexCache.get(state);
  if (!cached) {
    cached = buildLiveMdSearchVisibilityIndex(state);
    visibilityIndexCache.set(state, cached);
  }
  return cached;
}

function buildLiveMdSearchVisibilityIndex(state: EditorState) {
  let tree = syntaxTree(state);
  let service = state.facet(liveMdMarkdownParserServiceFacet);
  let ranges: Array<{ from: number; to: number }> = [];
  collectHiddenMarkdownSourceRanges(tree, ranges);
  let semanticSnapshot = liveMdSearchSemanticSnapshot(state);
  if (semanticSnapshot) {
    let dirtyInlineRanges = [...semanticSnapshot.dirtyRanges];
    forEachLeafAnalysisCacheRecord(semanticSnapshot.cache, (record) => {
      let mappedSourceRange = mapSemanticRange(record.sourceRange, 0, semanticSnapshot.changes);
      if (semanticSnapshot.dirtyRanges.some((range) => rangesTouch(mappedSourceRange, range))) {
        dirtyInlineRanges.push(mappedSourceRange);
        return;
      }
      let offset = record.sourceRange.from;
      for (let descriptor of record.analysis.structuralEffects) {
        collectHiddenSemanticDescriptor(descriptor, offset, semanticSnapshot.changes, ranges);
      }
      for (let descriptor of record.analysis.descriptors) {
        collectHiddenSemanticDescriptor(descriptor, offset, semanticSnapshot.changes, ranges);
      }
    });
    if (service && dirtyInlineRanges.length) {
      withLiveMdMarkdownInlineTreesInRanges(
        service,
        state.doc,
        tree,
        normalizeRanges(dirtyInlineRanges),
        (inlineTrees) => {
          for (let inlineTree of inlineTrees) {
            collectHiddenMarkdownSourceRanges(inlineTree, ranges);
          }
        },
      );
    }
  } else if (semanticSnapshot === undefined && service) {
    withLiveMdMarkdownInlineTrees(service, state.doc, tree, (inlineTrees) => {
      for (let inlineTree of inlineTrees) collectHiddenMarkdownSourceRanges(inlineTree, ranges);
    });
  }
  return rangeSetFromRanges(ranges);
}

function collectHiddenSemanticDescriptor(
  descriptor: LiveMdDescriptor,
  offset: number,
  changes: ChangeDesc | null,
  ranges: Array<{ from: number; to: number }>,
) {
  let add = (range: { from: number; to: number }) => {
    let mapped = mapSemanticRange(range, offset, changes);
    addHiddenRange(ranges, mapped.from, mapped.to);
  };
  switch (descriptor.kind) {
    case "syntax":
    case "listMarker":
    case "taskMarker":
      add(descriptor.range);
      return;
    case "linkMark":
      add({ from: descriptor.sourceRange.from, to: descriptor.range.from });
      add({ from: descriptor.range.to, to: descriptor.sourceRange.to });
      return;
    case "image":
      if (!descriptor.descriptionRange) {
        add(descriptor.range);
      } else {
        add({ from: descriptor.range.from, to: descriptor.descriptionRange.from });
        add({ from: descriptor.descriptionRange.to, to: descriptor.range.to });
      }
      return;
    case "latex": {
      let contentOffset = descriptor.formula.source.indexOf(descriptor.formula.tex);
      if (contentOffset < 0) return;
      add({ from: descriptor.range.from, to: descriptor.range.from + contentOffset });
      add({
        from: descriptor.range.from + contentOffset + descriptor.formula.tex.length,
        to: descriptor.range.to,
      });
      return;
    }
    case "table":
      for (let range of descriptor.pipeRanges) add(range);
      return;
    case "feature":
      if (descriptor.effect.kind == "syntax") add(descriptor.effect.range);
      return;
  }
}

function mapSemanticRange(
  range: { from: number; to: number },
  offset: number,
  changes: ChangeDesc | null,
) {
  let from = range.from + offset;
  let to = range.to + offset;
  if (!changes) return { from, to };
  let mappedFrom = changes.mapPos(from, 1);
  return { from: mappedFrom, to: Math.max(mappedFrom, changes.mapPos(to, -1)) };
}

function rangesTouch(left: { from: number; to: number }, right: { from: number; to: number }) {
  return left.from <= right.to && right.from <= left.to;
}

function collectHiddenMarkdownSourceRanges(
  tree: Tree,
  ranges: Array<{ from: number; to: number }>,
) {
  tree.iterate({
    enter(node) {
      if (isHiddenMarkdownNode(node)) {
        addHiddenRange(ranges, node.from, node.to);
        return false;
      }

      if (node.name == "inline_link") {
        addRangesOutsideChild(ranges, node, "link_text");
      } else if (node.name == "image") {
        addRangesOutsideChild(ranges, node, "image_description");
      } else if (node.name == "uri_autolink") {
        addHiddenRange(ranges, node.from, node.from + 1);
        addHiddenRange(ranges, node.to - 1, node.to);
      }

      return undefined;
    },
  });
}

function isHiddenMarkdownNode(node: SyntaxNode) {
  let { name } = node;
  switch (name) {
    case "|":
    case "block_continuation":
    case "block_quote_marker":
    case "code_span_delimiter":
    case "emphasis_delimiter":
    case "fenced_code_block_delimiter":
    case "latex_span_delimiter":
    case "link_destination":
    case "link_reference_definition":
    case "link_title":
    case "pipe_table_align_left":
    case "pipe_table_align_right":
    case "pipe_table_delimiter_cell":
    case "pipe_table_delimiter_row":
    case "task_list_marker_checked":
    case "task_list_marker_unchecked":
    case "thematic_break":
      return true;
    default:
      return (
        /^atx_h[1-6]/.test(name) || name.startsWith("list_marker_") || /^setext_h[12]_/.test(name)
      );
  }
}

function addRangesOutsideChild(
  ranges: Array<{ from: number; to: number }>,
  node: SyntaxNode,
  childName: string,
) {
  let child = node.getChild(childName);
  if (!child) {
    addHiddenRange(ranges, node.from, node.to);
    return;
  }
  addHiddenRange(ranges, node.from, child.from);
  addHiddenRange(ranges, child.to, node.to);
}

function addHiddenRange(ranges: Array<{ from: number; to: number }>, from: number, to: number) {
  if (from < to) ranges.push({ from, to });
}

function rangeSetFromRanges(ranges: Array<{ from: number; to: number }>) {
  let builder = new RangeSetBuilder<HiddenSourceRange>();
  for (let range of normalizeRanges(ranges)) {
    builder.add(range.from, range.to, hiddenSourceRange);
  }
  return builder.finish();
}

function normalizeRanges(ranges: Array<{ from: number; to: number }>) {
  let normalized: Array<{ from: number; to: number }> = [];
  for (let range of ranges.sort((left, right) => left.from - right.from || left.to - right.to)) {
    let previous = normalized.at(-1);
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      normalized.push({ ...range });
    }
  }
  return normalized;
}
