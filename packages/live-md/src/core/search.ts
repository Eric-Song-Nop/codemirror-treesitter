import {
  EditorState,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  type Extension,
  type StateEffect,
  type Transaction,
} from "@codemirror/state";
import { SearchQuery, search, searchKeymap, setSearchQuery } from "@codemirror/search";
import { syntaxTree, type SyntaxNode, type Tree } from "@codemirror-treesitter/language";
import { keymap } from "@codemirror/view";
import { liveMdMarkdownParserServiceFacet, withLiveMdMarkdownInlineTrees } from "./languages.js";

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
  if (service) {
    withLiveMdMarkdownInlineTrees(service, state.doc, tree, (inlineTrees) => {
      for (let inlineTree of inlineTrees) collectHiddenMarkdownSourceRanges(inlineTree, ranges);
    });
  }
  return rangeSetFromRanges(ranges);
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
