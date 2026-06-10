import { EditorState, type Extension, type StateEffect, type Transaction } from "@codemirror/state";
import { SearchQuery, search, searchKeymap, setSearchQuery } from "@codemirror/search";
import {
  ensureSyntaxTree,
  queryTreeCaptures,
  syntaxTree,
  type SyntaxNode,
  type Tree,
  type TreeSitterParser,
} from "@codemirror-treesitter/language";
import { keymap } from "@codemirror/view";
import { liveMdFeatureFacet, type LiveMdFeature, type LiveMdQueryTarget } from "./features.js";

type SearchTest = NonNullable<SearchQuery["test"]>;

const liveMdSearchTests = new WeakSet<SearchTest>();
const combinedSearchTests = new WeakMap<SearchTest, SearchTest>();

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
  let featureVisibility = liveMdFeatureSearchVisibility(state, from, to);
  if (featureVisibility != null) return featureVisibility;
  if (isHiddenMarkdownSourceRange(state, from, to)) return false;

  let visible = true;
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (!visible || !rangesOverlap(from, to, node.from, node.to)) return false;

      if (isHiddenMarkdownNode(node)) {
        visible = false;
        return false;
      }

      if (node.name == "inline_link" && rangeOverlapsOutsideChild(node, "link_text", from, to)) {
        visible = false;
        return false;
      }

      if (node.name == "image" && rangeOverlapsOutsideChild(node, "image_description", from, to)) {
        visible = false;
        return false;
      }

      if (
        node.name == "uri_autolink" &&
        (rangesOverlap(from, to, node.from, node.from + 1) ||
          rangesOverlap(from, to, node.to - 1, node.to))
      ) {
        visible = false;
        return false;
      }

      return undefined;
    },
  });
  return visible;
}

function liveMdFeatureSearchVisibility(state: EditorState, from: number, to: number) {
  let features = state.facet(liveMdFeatureFacet);
  if (!features.length) return undefined;

  if (isHiddenByFeatureSearchQuery(state, features, from, to)) return false;

  for (let feature of features) {
    let visible = feature.search?.isVisible?.(
      { from, to },
      {
        state,
        text: (node) => state.sliceDoc(node.from, node.to),
      },
    );
    if (visible != null) return visible;
  }

  return undefined;
}

function isHiddenByFeatureSearchQuery(
  state: EditorState,
  features: readonly LiveMdFeature[],
  from: number,
  to: number,
) {
  let source = liveMdFeatureSearchQuerySource(features);
  if (!source) return false;
  let tree = ensureSyntaxTree(state, to, 50) ?? syntaxTree(state);
  return queryTreeCaptures(tree, source).some((capture) =>
    rangesOverlap(from, to, capture.node.from, capture.node.to),
  );
}

function liveMdFeatureSearchQuerySource(features: readonly LiveMdFeature[]) {
  if (!features.some((feature) => feature.search?.hiddenQuery)) return null;
  return (_parser: TreeSitterParser, tree: Tree) => {
    let target = liveMdSearchQueryTarget(tree);
    if (!target) return null;
    let sources = features
      .map((feature) => feature.search?.hiddenQuery?.[target]?.trim())
      .filter((source): source is string => !!source);
    return sources.length ? sources.join("\n\n") : null;
  };
}

function liveMdSearchQueryTarget(tree: Tree): LiveMdQueryTarget | null {
  if (tree.topNode.name == "document") return "document";
  if (tree.topNode.name == "inline") return "inline";
  return null;
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

function rangeOverlapsOutsideChild(node: SyntaxNode, childName: string, from: number, to: number) {
  let child = node.getChild(childName);
  if (!child) return rangesOverlap(from, to, node.from, node.to);
  return (
    rangesOverlap(from, to, node.from, child.from) || rangesOverlap(from, to, child.to, node.to)
  );
}

function isHiddenMarkdownSourceRange(state: EditorState, from: number, to: number) {
  let source = state.sliceDoc(from, to);
  if (!source) return false;

  let line = state.doc.lineAt(from);
  let lineFrom = from - line.from;
  let lineTo = to - line.from;
  if (to > line.to || lineTo > line.text.length) return false;

  if (isAtxHeadingMarker(line.text, lineFrom, lineTo)) return true;
  if (isSetextHeadingUnderline(line.text, lineFrom, lineTo)) return true;
  if (isAutolinkBracket(line.text, lineFrom, lineTo)) return true;
  if (isInlineLinkDestination(line.text, lineFrom, lineTo)) return true;
  if (isInlineDelimiter(line.text, lineFrom, lineTo)) return true;
  if (isListMarker(line.text, lineFrom, lineTo)) return true;
  if (isTableSyntax(state, line.number, line.text, lineFrom, lineTo)) return true;

  return false;
}

function isAtxHeadingMarker(line: string, from: number, to: number) {
  let match = /^(#{1,6})(?=\s)/.exec(line);
  return Boolean(match && from >= 0 && to <= match[1]!.length);
}

function isSetextHeadingUnderline(line: string, from: number, to: number) {
  return from >= 0 && to <= line.length && /^\s*(?:=+|-+)\s*$/.test(line);
}

function isAutolinkBracket(line: string, from: number, to: number) {
  if (to != from + 1 || (line[from] != "<" && line[from] != ">")) return false;
  let open = line.lastIndexOf("<", from);
  let close = line.indexOf(">", from);
  return open > -1 && close > open + 1 && /\S/.test(line.slice(open + 1, close));
}

function isInlineLinkDestination(line: string, from: number, to: number) {
  let open = line.lastIndexOf("](", from);
  if (open < 0 || from < open + 2) return false;
  let close = line.indexOf(")", open + 2);
  return close > -1 && to <= close;
}

function isInlineDelimiter(line: string, from: number, to: number) {
  let source = line.slice(from, to);
  if (!/^(?:[*]+|~~)$/.test(source)) return false;

  let before = line.slice(0, from);
  let after = line.slice(to);
  let opens = /\S/.test(after[0] ?? "") && after.includes(source);
  let closes = /\S/.test(before.at(-1) ?? "") && before.includes(source);
  return opens || closes;
}

function isListMarker(line: string, from: number, to: number) {
  let marker = /^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/.exec(line)?.[0];
  return Boolean(marker && from >= 0 && to <= marker.length);
}

function isTableSyntax(
  state: EditorState,
  lineNumber: number,
  line: string,
  from: number,
  to: number,
) {
  let source = line.slice(from, to);
  if (isPipeTableDelimiterLine(line)) return true;
  if (source != "|") return false;

  let previous = lineNumber > 1 ? state.doc.line(lineNumber - 1).text : "";
  let next = lineNumber < state.doc.lines ? state.doc.line(lineNumber + 1).text : "";
  return isPipeTableDelimiterLine(previous) || isPipeTableDelimiterLine(next);
}

function isPipeTableDelimiterLine(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function rangesOverlap(fromA: number, toA: number, fromB: number, toB: number) {
  return fromA < toB && fromB < toA;
}
