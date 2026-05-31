import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Edit, Language, Parser, Query } from "web-tree-sitter";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await Parser.init();

const languages = {
  javascript: await loadLanguage("node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm"),
  markdown: await loadLanguage("packages/language-data/src/wasm/tree-sitter-markdown.wasm"),
  markdownInline: await loadLanguage(
    "packages/language-data/src/wasm/tree-sitter-markdown-inline.wasm",
  ),
};

const parsers = {
  javascript: createParser(languages.javascript),
  markdown: createParser(languages.markdown),
  markdownInline: createParser(languages.markdownInline),
};

const suites = {
  javascript: {
    label: "javascript",
    language: languages.javascript,
    parse(text, oldTree = null) {
      return parseText(parsers.javascript, text, oldTree);
    },
  },
  markdownBlock: {
    label: "markdown:block",
    language: languages.markdown,
    parse(text, oldTree = null) {
      return parseText(parsers.markdown, text, oldTree);
    },
  },
  markdownInline: {
    label: "markdown:inline",
    language: languages.markdownInline,
    parse(text, oldTree = null) {
      let markdownTree = parseText(parsers.markdown, text);
      return parseText(parsers.markdownInline, text, oldTree, inlineRanges(markdownTree, text));
    },
  },
};

const cases = [
  {
    name: "same-width identifier rename",
    suite: suites.javascript,
    oldText: "let foo = 1;\n",
    change: replaceFirst("foo", "bar"),
    expectAncestorIncludes: ["identifier"],
    expectChangedRanges: [],
    expectCoverType: "identifier",
    query: "(identifier) @hit",
    expectQueryHitType: "identifier",
  },
  {
    name: "insert at identifier start",
    suite: suites.javascript,
    oldText: "let foo = 1;\n",
    change: insertAtFirst("foo", "x"),
    expectAncestorIncludes: ["identifier"],
    expectLeafCoversDirty: false,
    query: "(identifier) @hit",
    expectQueryHitType: "identifier",
  },
  {
    name: "insert inside identifier",
    suite: suites.javascript,
    oldText: "let foo = 1;\n",
    change: insertAtFirst("oo", "x"),
    expectAncestorIncludes: ["identifier"],
    expectChangedRanges: [],
    expectCoverType: "identifier",
    query: "(identifier) @hit",
    expectQueryHitType: "identifier",
  },
  {
    name: "delete inside identifier",
    suite: suites.javascript,
    oldText: "let foo = 1;\n",
    change: deleteFirst("o"),
    expectAncestorIncludes: ["identifier"],
    expectChangedRanges: [],
    expectCoverType: "identifier",
    query: "(identifier) @hit",
    expectQueryHitType: "identifier",
  },
  {
    name: "insert before operator boundary",
    suite: suites.javascript,
    oldText: "let foo = 1;\n",
    change: insertAtFirst("=", " "),
    expectAncestorIncludes: ["variable_declarator"],
    expectChangedRanges: [],
    expectLeafCoversDirty: false,
    query: "(variable_declarator) @hit",
    expectQueryHitType: "variable_declarator",
  },
  {
    name: "function body statement rename",
    suite: suites.javascript,
    oldText: "function f() {\n  let value = 1;\n}\n",
    change: replaceFirst("value", "count"),
    expectAncestorIncludes: ["identifier", "variable_declarator", "statement_block"],
    expectChangedRanges: [],
    query: "(identifier) @hit",
    expectQueryHitType: "identifier",
  },
  {
    name: "string content same-width edit",
    suite: suites.javascript,
    oldText: 'const msg = "one";\n',
    change: replaceFirst("one", "two"),
    expectAncestorIncludes: ["string"],
    expectChangedRanges: [],
    query: "(string) @hit",
    expectQueryHitType: "string",
  },
  {
    name: "template string interior edit",
    suite: suites.javascript,
    oldText: "const msg = `hello ${name}`;\n",
    change: replaceFirst("hello", "hi"),
    expectAncestorIncludes: ["template_string"],
    query: "(template_string) @hit",
    expectQueryHitType: "template_string",
  },
  {
    name: "comment same-width edit",
    suite: suites.javascript,
    oldText: "// one\nlet x = 1;\n",
    change: replaceFirst("one", "two"),
    expectAncestorIncludes: ["comment", "program"],
    expectChangedRanges: [],
    query: "(comment) @hit",
    expectQueryHitType: "comment",
  },
  {
    name: "markdown blank line splits paragraph",
    suite: suites.markdownBlock,
    oldText: "alpha\nbeta\n",
    change: insertAtFirst("beta", "\n"),
    expectAncestorIncludes: ["section", "document"],
  },
  {
    name: "markdown heading text rename",
    suite: suites.markdownBlock,
    oldText: "# Old\n\nnext\n",
    change: replaceFirst("Old", "New"),
    expectAncestorIncludes: ["inline", "atx_heading"],
    expectChangedRanges: [],
    query: "(inline) @hit",
    expectQueryHitType: "inline",
  },
  {
    name: "markdown heading marker edit",
    suite: suites.markdownBlock,
    oldText: "# Old\n\nnext\n",
    change: insertAtFirst("#", "#"),
    expectAncestorIncludes: ["atx_h2_marker", "atx_heading"],
    query: "(atx_heading) @hit",
    expectQueryHitType: "atx_heading",
  },
  {
    name: "markdown blockquote text rename",
    suite: suites.markdownBlock,
    oldText: "> quote\n\nnext\n",
    change: replaceFirst("quote", "cited"),
    expectAncestorIncludes: ["inline", "paragraph", "block_quote"],
    expectChangedRanges: [],
    query: "(inline) @hit",
    expectQueryHitType: "inline",
  },
  {
    name: "markdown blockquote marker deletion",
    suite: suites.markdownBlock,
    oldText: "> quote\n\nnext\n",
    change: deleteFirst("> "),
    expectAncestorIncludes: ["paragraph", "section", "document"],
  },
  {
    name: "markdown list item text rename",
    suite: suites.markdownBlock,
    oldText: "- first\n- second\n",
    change: replaceFirst("second", "second!"),
    expectAncestorIncludes: ["inline", "paragraph", "list_item", "list"],
    query: "(inline) @hit",
    expectQueryHitType: "inline",
  },
  {
    name: "markdown list marker kind edit",
    suite: suites.markdownBlock,
    oldText: "- first\n- second\n",
    change: replaceFirst("- second", "* second"),
    expectAncestorIncludes: ["list_item", "list"],
    query: "(list_marker_star) @hit",
    expectQueryHitType: "list_marker_star",
  },
  {
    name: "markdown task marker toggle",
    suite: suites.markdownBlock,
    oldText: "- [ ] task\n",
    change: replaceFirst("[ ]", "[x]"),
    expectAncestorIncludes: ["task_list_marker_checked", "list_item", "list"],
    query: "(task_list_marker_checked) @hit",
    expectQueryHitType: "task_list_marker_checked",
  },
  {
    name: "markdown thematic break edit",
    suite: suites.markdownBlock,
    oldText: "---\n\nnext\n",
    change: replaceFirst("---", "***"),
    expectAncestorIncludes: ["thematic_break", "section"],
    query: "(thematic_break) @hit",
    expectQueryHitType: "thematic_break",
  },
  {
    name: "markdown code fence content rename",
    suite: suites.markdownBlock,
    oldText: "```ts\nlet x = 1;\n```\n",
    change: replaceFirst("x", "y"),
    expectAncestorIncludes: ["code_fence_content", "fenced_code_block"],
    expectChangedRanges: [],
    expectCoverType: "code_fence_content",
    query: "(code_fence_content) @hit",
    expectQueryHitType: "code_fence_content",
  },
  {
    name: "markdown code fence language rename",
    suite: suites.markdownBlock,
    oldText: "```ts\nlet x = 1;\n```\n",
    change: replaceFirst("ts", "js"),
    expectAncestorIncludes: ["language", "info_string", "fenced_code_block"],
    expectChangedRanges: [],
    query: "(info_string) @hit",
    expectQueryHitType: "info_string",
  },
  {
    name: "markdown code fence closing delimiter deletion",
    suite: suites.markdownBlock,
    oldText: "```ts\nlet x = 1;\n```\n\nnext\n",
    change: deleteFirst("```\n\nnext"),
    expectAncestorIncludes: ["code_fence_content", "fenced_code_block"],
  },
  {
    name: "markdown mermaid content rename",
    suite: suites.markdownBlock,
    oldText: "```mermaid\ngraph TD\nA-->B\n```\n",
    change: replaceFirst("TD", "LR"),
    expectAncestorIncludes: ["code_fence_content", "fenced_code_block"],
    expectChangedRanges: [],
    query: "(code_fence_content) @hit",
    expectQueryHitType: "code_fence_content",
  },
  {
    name: "markdown table body cell edit",
    suite: suites.markdownBlock,
    oldText: "| A | B |\n| - | - |\n| c | d |\n",
    change: replaceFirst("c", "cc"),
    expectAncestorIncludes: ["pipe_table_cell", "pipe_table_row", "pipe_table"],
    query: "(pipe_table_cell) @hit",
    expectQueryHitType: "pipe_table_cell",
  },
  {
    name: "markdown table delimiter alignment edit",
    suite: suites.markdownBlock,
    oldText: "| A | B |\n| - | - |\n| c | d |\n",
    change: replaceFirst("| - | - |", "| - | --: |"),
    expectAncestorIncludes: ["pipe_table_delimiter_row", "pipe_table"],
    query: "(pipe_table_delimiter_cell) @hit",
    expectQueryHitType: "pipe_table_delimiter_cell",
  },
  {
    name: "markdown html block content edit",
    suite: suites.markdownBlock,
    oldText: "<div>\ncontent\n</div>\n\nnext\n",
    change: replaceFirst("content", "updated"),
    expectAncestorIncludes: ["html_block", "section"],
    query: "(html_block) @hit",
    expectQueryHitType: "html_block",
  },
  {
    name: "markdown indented code content edit",
    suite: suites.markdownBlock,
    oldText: "    one\n    two\n\nnext\n",
    change: replaceFirst("two", "dos"),
    expectAncestorIncludes: ["indented_code_block", "section"],
    query: "(indented_code_block) @hit",
    expectQueryHitType: "indented_code_block",
  },
  {
    name: "markdown link reference destination edit",
    suite: suites.markdownBlock,
    oldText: "[id]: https://one.test\n\nnext\n",
    change: replaceFirst("one", "two"),
    expectAncestorIncludes: ["link_reference_definition", "section"],
    query: "(link_reference_definition) @hit",
    expectQueryHitType: "link_reference_definition",
  },
  {
    name: "markdown yaml metadata title edit",
    suite: suites.markdownBlock,
    oldText: "---\ntitle: One\n---\n\nnext\n",
    change: replaceFirst("One", "Two"),
    expectAncestorIncludes: ["minus_metadata", "document"],
    query: "(minus_metadata) @hit",
    expectQueryHitType: "minus_metadata",
  },
  {
    name: "markdown image destination rename",
    suite: suites.markdownInline,
    oldText: "![alt](one.png)\nnext\n",
    change: replaceFirst("one", "two"),
    expectAncestorIncludes: ["link_destination", "image"],
    expectChangedRanges: [],
    expectCoverType: "link_destination",
    query: "(link_destination) @hit",
    expectQueryHitType: "link_destination",
  },
  {
    name: "markdown image alt edit",
    suite: suites.markdownInline,
    oldText: "![alt](one.png)\nnext\n",
    change: replaceFirst("alt", "label"),
    expectAncestorIncludes: ["image_description", "image"],
    query: "(image_description) @hit",
    expectQueryHitType: "image_description",
  },
  {
    name: "markdown whole image deletion leaves neighboring paragraph context",
    suite: suites.markdownBlock,
    oldText: "![alt](one.png)\nnext\n",
    change: deleteFirst("![alt](one.png)"),
    expectAncestorIncludes: ["paragraph", "section", "document"],
  },
  {
    name: "markdown inline link text edit",
    suite: suites.markdownInline,
    oldText: "[text](one)\n",
    change: replaceFirst("text", "label"),
    expectAncestorIncludes: ["link_text", "inline_link"],
    query: "(link_text) @hit",
    expectQueryHitType: "link_text",
  },
  {
    name: "markdown inline link destination edit",
    suite: suites.markdownInline,
    oldText: "[text](one)\n",
    change: replaceFirst("one", "two"),
    expectAncestorIncludes: ["link_destination", "inline_link"],
    expectChangedRanges: [],
    query: "(link_destination) @hit",
    expectQueryHitType: "link_destination",
  },
  {
    name: "markdown uri autolink edit",
    suite: suites.markdownInline,
    oldText: "<https://one.test>\n",
    change: replaceFirst("one", "two"),
    expectAncestorIncludes: ["uri_autolink"],
    expectChangedRanges: [],
    query: "(uri_autolink) @hit",
    expectQueryHitType: "uri_autolink",
  },
  {
    name: "markdown inline latex rename",
    suite: suites.markdownInline,
    oldText: "$x^2$ and text\n",
    change: replaceFirst("x", "y"),
    expectAncestorIncludes: ["latex_block"],
    expectChangedRanges: [],
    expectCoverType: "latex_block",
    query: "(latex_block) @hit",
    expectQueryHitType: "latex_block",
  },
  {
    name: "markdown display latex body edit",
    suite: suites.markdownInline,
    oldText: "$$\nE = mc^2\n$$\n\nnext\n",
    change: replaceFirst("mc", "mv"),
    expectAncestorIncludes: ["latex_block"],
    expectChangedRanges: [],
    query: "(latex_block) @hit",
    expectQueryHitType: "latex_block",
  },
  {
    name: "markdown inline code edit",
    suite: suites.markdownInline,
    oldText: "`code` and text\n",
    change: replaceFirst("code", "span"),
    expectAncestorIncludes: ["code_span"],
    expectChangedRanges: [],
    query: "(code_span) @hit",
    expectQueryHitType: "code_span",
  },
  {
    name: "markdown strong text edit",
    suite: suites.markdownInline,
    oldText: "**bold** and text\n",
    change: replaceFirst("bold", "loud"),
    expectAncestorIncludes: ["strong_emphasis"],
    expectChangedRanges: [],
    query: "(strong_emphasis) @hit",
    expectQueryHitType: "strong_emphasis",
  },
  {
    name: "markdown emphasis delimiter deletion",
    suite: suites.markdownInline,
    oldText: "*em* and text\n",
    change: deleteFirst("*"),
    expectAncestorIncludes: ["inline"],
  },
  {
    name: "markdown strikethrough text edit",
    suite: suites.markdownInline,
    oldText: "~~gone~~ and text\n",
    change: replaceFirst("gone", "away"),
    expectAncestorIncludes: ["strikethrough"],
    expectChangedRanges: [],
    query: "(strikethrough) @hit",
    expectQueryHitType: "strikethrough",
  },
];

function probe(testCase) {
  let oldTree = testCase.suite.parse(testCase.oldText);
  let newText = applyChange(testCase.oldText, testCase.change);
  let edit = treeEdit(testCase.oldText, newText, testCase.change);
  let editedOldTree = oldTree.copy();
  editedOldTree.edit(edit);
  let newTree = testCase.suite.parse(newText, editedOldTree);
  let changedRanges = editedOldTree
    .getChangedRanges(newTree)
    .map((range) => ({ from: range.startIndex, to: range.endIndex }));
  let dirty = {
    from: testCase.change.from,
    to: testCase.change.from + testCase.change.insert.length,
  };
  let changedLeaves = collectChangedLeaves(editedOldTree.rootNode);
  let coverNode = changedAncestorFromDirty(editedOldTree.rootNode, dirty, newText.length);
  let dirtyAncestors = dirtySeededAncestors(newTree.rootNode, dirty, newText);
  let queryHits = testCase.query
    ? queryDirtyRange(testCase.suite.language, newTree.rootNode, testCase.query, dirty, newText)
    : [];

  return {
    newText,
    dirty,
    changedRanges,
    changedLeaves,
    coverNode,
    dirtyAncestors,
    queryHits,
    leafCoversDirty: changedLeaves.some((node) => coversDirty(nodeRange(node), dirty)),
  };
}

function assertProbe(testCase, result) {
  if (testCase.expectChangedRanges) {
    assert.deepEqual(result.changedRanges, testCase.expectChangedRanges, testCase.name);
  }
  if (testCase.expectCoverType) {
    assert.equal(result.coverNode?.type, testCase.expectCoverType, testCase.name);
  }
  if (testCase.expectLeafCoversDirty !== undefined) {
    assert.equal(result.leafCoversDirty, testCase.expectLeafCoversDirty, testCase.name);
  }
  for (let type of testCase.expectAncestorIncludes ?? []) {
    assert(
      result.dirtyAncestors.some((node) => node.type == type),
      `${testCase.name}: dirty-seeded new-tree ancestors missed ${type}; got ${formatNodeTypes(
        result.dirtyAncestors,
      )}`,
    );
  }
  if (testCase.expectQueryHitType) {
    assert.equal(result.queryHits[0]?.type, testCase.expectQueryHitType, testCase.name);
  }
  assert(
    result.coverNode || result.changedRanges.some((range) => coversDirty(range, result.dirty)),
    `${testCase.name}: no Tree-sitter-derived range covers ${formatRange(result.dirty)}`,
  );
}

function queryDirtyRange(language, rootNode, source, dirty, text) {
  let query = new Query(language, source);
  try {
    let result = [];
    for (let range of lookupRanges(dirty, text.length, text)) {
      result.push(
        ...query
          .captures(rootNode, {
            startPosition: pointAt(text, range.from),
            endPosition: pointAt(text, range.to),
          })
          .map((capture) => capture.node),
      );
    }
    return dedupeNodes(result);
  } finally {
    query.delete();
  }
}

function dedupeNodes(nodes) {
  let ids = new Set();
  let result = [];
  for (let node of nodes) {
    if (ids.has(node.id)) continue;
    ids.add(node.id);
    result.push(node);
  }
  return result;
}

async function loadLanguage(relativePath) {
  return Language.load(resolve(root, relativePath));
}

function createParser(language) {
  let parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

function parseText(parser, text, oldTree = null, includedRanges) {
  return parser.parse(
    (index) => {
      if (index >= text.length) return undefined;
      return text.slice(index, Math.min(text.length, index + 4096));
    },
    oldTree,
    includedRanges ? { includedRanges } : undefined,
  );
}

function inlineRanges(markdownTree, text) {
  let ranges = [];
  walk(markdownTree.rootNode, (node) => {
    if (node.type != "inline" && node.type != "pipe_table_cell") return true;
    ranges.push(...rangesExcludingNamedChildren(node, text));
    return false;
  });
  return ranges;
}

function rangesExcludingNamedChildren(node, text) {
  let ranges = [];
  let from = node.startIndex;
  for (let child of node.children) {
    if (!child.isNamed) continue;
    if (from < child.startIndex) ranges.push(tsRange(text, from, child.startIndex));
    from = Math.max(from, child.endIndex);
  }
  if (from < node.endIndex) ranges.push(tsRange(text, from, node.endIndex));
  return ranges;
}

function changedAncestorFromDirty(rootNode, dirty, docLength) {
  let candidates = lookupRanges(dirty, docLength)
    .map((range) => rootNode.descendantForIndex(range.from, range.to))
    .filter(Boolean)
    .map((node) => nearestChangedAncestor(node, dirty))
    .filter(Boolean);
  candidates.sort((a, b) => nodeWidth(a) - nodeWidth(b));
  return candidates[0] ?? null;
}

function dirtySeededAncestors(rootNode, dirty, text) {
  let result = [];
  let seen = new Set();
  for (let range of lookupRanges(dirty, text.length, text)) {
    let node = rootNode.descendantForIndex(range.from, range.to);
    for (let current = node; current; current = current.parent) {
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      result.push(current);
    }
  }
  result.sort((a, b) => nodeWidth(a) - nodeWidth(b) || a.startIndex - b.startIndex);
  return result;
}

function nearestChangedAncestor(node, dirty) {
  for (let current = node; current; current = current.parent) {
    if (current.hasChanges && coversDirty(nodeRange(current), dirty)) return current;
  }
  return null;
}

function lookupRanges(dirty, docLength, text = "") {
  if (dirty.from < dirty.to) return [dirty];
  let ranges = [{ from: dirty.from, to: dirty.to }];
  if (dirty.from < docLength) ranges.push({ from: dirty.from, to: dirty.from + 1 });
  if (dirty.from > 0) ranges.push({ from: dirty.from - 1, to: dirty.from });
  let next = nextNonWhitespace(text, dirty.from);
  if (next < docLength) ranges.push({ from: next, to: next + 1 });
  let previous = previousNonWhitespace(text, dirty.from);
  if (previous >= 0) ranges.push({ from: previous, to: previous + 1 });
  return ranges;
}

function nextNonWhitespace(text, from) {
  for (let index = from; index < text.length; index++) {
    if (!/\s/u.test(text[index])) return index;
  }
  return text.length;
}

function previousNonWhitespace(text, from) {
  for (let index = Math.min(from - 1, text.length - 1); index >= 0; index--) {
    if (!/\s/u.test(text[index])) return index;
  }
  return -1;
}

function collectChangedLeaves(node) {
  if (!node.hasChanges) return [];
  let childLeaves = node.children.flatMap((child) => collectChangedLeaves(child));
  return childLeaves.length ? childLeaves : [node];
}

function walk(node, enter) {
  if (!enter(node)) return;
  for (let child of node.children) walk(child, enter);
}

function treeEdit(oldText, newText, change) {
  let startPosition = pointAt(newText, change.from);
  return new Edit({
    startIndex: change.from,
    oldEndIndex: change.to,
    newEndIndex: change.from + change.insert.length,
    startPosition,
    oldEndPosition: pointAfterText(startPosition, oldText.slice(change.from, change.to)),
    newEndPosition: pointAt(newText, change.from + change.insert.length),
  });
}

function tsRange(text, from, to) {
  return {
    startIndex: from,
    endIndex: to,
    startPosition: pointAt(text, from),
    endPosition: pointAt(text, to),
  };
}

function pointAt(text, index) {
  let row = 0;
  let column = 0;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) == 10) {
      row++;
      column = 0;
    } else {
      column++;
    }
  }
  return { row, column };
}

function pointAfterText(point, text) {
  let row = point.row;
  let column = point.column;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) == 10) {
      row++;
      column = 0;
    } else {
      column++;
    }
  }
  return { row, column };
}

function applyChange(text, change) {
  return text.slice(0, change.from) + change.insert + text.slice(change.to);
}

function replaceFirst(search, insert) {
  return (text) => {
    let from = text.indexOf(search);
    assert.notEqual(from, -1, search);
    return { from, to: from + search.length, insert };
  };
}

function insertAtFirst(search, insert) {
  return (text) => {
    let from = text.indexOf(search);
    assert.notEqual(from, -1, search);
    return { from, to: from, insert };
  };
}

function deleteFirst(search) {
  return replaceFirst(search, "");
}

for (let testCase of cases) {
  if (typeof testCase.change == "function") {
    testCase.change = testCase.change(testCase.oldText);
  }
}

let rows = [];
for (let testCase of cases) {
  let result = probe(testCase);
  assertProbe(testCase, result);
  rows.push({
    suite: testCase.suite.label,
    case: testCase.name,
    dirty: formatRange(result.dirty),
    getChangedRanges: formatRanges(result.changedRanges),
    dirtySeededAncestor: formatNode(result.coverNode),
    newTreeAncestors: formatNodeTypes(result.dirtyAncestors.slice(0, 6)),
    queryHit: result.queryHits.length ? formatNode(result.queryHits[0]) : "",
    leafCoversDirty: result.leafCoversDirty ? "yes" : "no",
  });
}

console.table(rows);
console.log(
  [
    "Observation:",
    "- getChangedRanges is empty for several same-shape text edits.",
    "- Changed leaves can miss boundary insertions.",
    "- Seeding the new tree from the edit range reaches the LiveMD feature ancestors across this matrix.",
    "- Range-limited queries are useful for leaf/local captures, but feature ancestors still need dirty-seeded tree climbing when the capture root starts before the dirty span.",
  ].join("\n"),
);

function nodeRange(node) {
  return { from: node.startIndex, to: node.endIndex };
}

function nodeWidth(node) {
  return node.endIndex - node.startIndex;
}

function coversDirty(range, dirty) {
  return range.from <= dirty.from && range.to >= dirty.to;
}

function formatRanges(ranges) {
  return ranges.length ? ranges.map(formatRange).join(" ") : "[]";
}

function formatRange(range) {
  return `[${range.from},${range.to}]`;
}

function formatNode(node) {
  return node ? `${node.type} ${formatRange(nodeRange(node))}` : "none";
}

function formatNodeTypes(nodes) {
  return nodes.map((node) => node.type).join(" > ");
}
