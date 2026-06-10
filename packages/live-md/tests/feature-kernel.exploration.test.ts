// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import {
  ensureSyntaxTree,
  queryTreeCaptures,
  queryTreeMatches,
  type Tree,
  type TreeSitterParser,
} from "@codemirror-treesitter/language";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { loadMarkdownExtension } from "../src/core/languages.js";

let locationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  if (locationDescriptor) {
    Object.defineProperty(globalThis, "location", locationDescriptor);
  }
});

describe("LiveMD feature-kernel exploration", () => {
  it("can classify existing LiveMD syntax through one combined query source", async () => {
    let { tree } = await markdownState(kitchenSinkDoc());
    let matches = queryTreeMatches(tree, featureQuerySource);
    let featureIds = new Set(
      matches
        .flatMap((match) => [
          match.setProperties?.["liveMd.feature"],
          match.assertedProperties?.["liveMd.feature"],
        ])
        .filter((value): value is string => typeof value == "string"),
    );

    expect([...featureIds].sort()).toEqual(
      expect.arrayContaining([
        "autolink",
        "blockquote",
        "codeFence",
        "heading",
        "image",
        "inlineMark",
        "latex",
        "link",
        "list",
        "paragraphBreak",
        "rule",
        "syntax",
        "table",
        "task",
      ]),
    );
  });

  it("can model feature-owned hidden search ranges with query captures", async () => {
    let doc = "# Heading\n\nParagraph with _emphasis_ and [link](https://example.com).\n";
    let { state, tree } = await markdownState(doc);
    let hiddenRanges = queryTreeCaptures(tree, searchHiddenQuerySource).map((capture) => ({
      from: capture.node.from,
      name: capture.name,
      text: state.sliceDoc(capture.node.from, capture.node.to),
      to: capture.node.to,
    }));

    expect(isHidden(hiddenRanges, doc.indexOf("#"), doc.indexOf("#") + 1)).toBe(true);
    expect(isHidden(hiddenRanges, doc.indexOf("Heading"), doc.indexOf("Heading") + 7)).toBe(false);
    expect(isHidden(hiddenRanges, doc.indexOf("_"), doc.indexOf("_") + 1)).toBe(true);
    expect(isHidden(hiddenRanges, doc.indexOf("emphasis"), doc.indexOf("emphasis") + 8)).toBe(
      false,
    );
    expect(isHidden(hiddenRanges, doc.indexOf("https://"), doc.indexOf("https://") + 8)).toBe(true);
    expect(isHidden(hiddenRanges, doc.indexOf("link"), doc.indexOf("link") + 4)).toBe(false);
  });
});

async function markdownState(doc: string) {
  let state = EditorState.create({
    doc,
    extensions: [await loadMarkdownExtension()],
  });
  let tree = ensureSyntaxTree(state, doc.length, 5_000);
  if (!tree) throw new Error("Markdown syntax tree did not finish parsing");
  return { state, tree };
}

function featureQuerySource(_parser: TreeSitterParser, tree: Tree) {
  if (tree.topNode.name == "document") return documentFeatureQuery;
  if (tree.topNode.name == "inline") return inlineFeatureQuery;
  return null;
}

function searchHiddenQuerySource(_parser: TreeSitterParser, tree: Tree) {
  if (tree.topNode.name == "document") return documentSearchHiddenQuery;
  if (tree.topNode.name == "inline") return inlineSearchHiddenQuery;
  return null;
}

function isHidden(
  ranges: readonly { from: number; name: string; text: string; to: number }[],
  from: number,
  to: number,
) {
  return ranges.some((range) => from >= range.from && to <= range.to);
}

const documentFeatureQuery = `
((document (section) @paragraph.child) @paragraph.container @feature
  (#set! liveMd.feature "paragraphBreak")
  (#set! paragraph.kind "document"))

((section [
  (atx_heading)
  (block_quote)
  (fenced_code_block)
  (list)
  (paragraph)
  (pipe_table)
  (setext_heading)
  (thematic_break)
] @paragraph.child) @paragraph.container @feature
  (#set! liveMd.feature "paragraphBreak")
  (#set! paragraph.kind "block"))

((list (list_item) @paragraph.child) @paragraph.container @feature
  (#set! liveMd.feature "paragraphBreak")
  (#set! paragraph.kind "list"))

((atx_heading . (atx_h1_marker) @heading.marker) @heading @feature
  (#set! liveMd.feature "heading")
  (#set! heading.level "1"))
((setext_heading heading_content: (paragraph) (setext_h1_underline) @heading.marker) @heading @feature
  (#set! liveMd.feature "heading")
  (#set! heading.level "1"))

((block_continuation) @syntax @feature
  (#set! liveMd.feature "syntax"))
((block_quote) @blockquote @feature
  (#set! liveMd.feature "blockquote"))
((block_quote_marker) @syntax @feature
  (#set! liveMd.feature "syntax"))
((list_item) @list.item @feature
  (#set! liveMd.feature "list"))
((list_marker_minus) @list.marker @feature
  (#set! liveMd.feature "list"))
((task_list_marker_checked) @task.checked @feature
  (#set! liveMd.feature "task"))
((task_list_marker_unchecked) @task.unchecked @feature
  (#set! liveMd.feature "task"))
((thematic_break) @rule @feature
  (#set! liveMd.feature "rule"))

((fenced_code_block
  .
  (fenced_code_block_delimiter) @codeFence.open
  (info_string (language) @codeFence.language)?
  (block_continuation)?
  (code_fence_content)? @codeFence.content
  (fenced_code_block_delimiter)? @codeFence.close
  .) @codeFence @feature
  (#set! liveMd.feature "codeFence"))

((pipe_table) @table @feature
  (#set! liveMd.feature "table"))
((pipe_table (pipe_table_header (pipe_table_cell) @table.header.cell) @table.header) @table @feature
  (#set! liveMd.feature "table"))
((pipe_table (pipe_table_delimiter_row) @table.delimiter.row) @table @feature
  (#set! liveMd.feature "table"))
((pipe_table
  (pipe_table_delimiter_row
    (pipe_table_delimiter_cell
      (pipe_table_align_left)? @table.align.left
      (pipe_table_align_right)? @table.align.right) @table.delimiter.cell)) @table @feature
  (#set! liveMd.feature "table"))
((pipe_table (pipe_table_row (pipe_table_cell) @table.row.cell) @table.row) @table @feature
  (#set! liveMd.feature "table"))
((pipe_table (pipe_table_header "|" @table.pipe)) @table @feature
  (#set! liveMd.feature "table"))
((pipe_table (pipe_table_delimiter_row "|" @table.pipe)) @table @feature
  (#set! liveMd.feature "table"))
((pipe_table (pipe_table_row "|" @table.pipe)) @table @feature
  (#set! liveMd.feature "table"))
`;

const inlineFeatureQuery = `
((code_span) @mark.inlineCode @feature
  (#set! liveMd.feature "inlineMark"))
((code_span_delimiter) @syntax @feature
  (#set! liveMd.feature "syntax"))
((emphasis) @mark.emphasis @feature
  (#set! liveMd.feature "inlineMark"))
((emphasis_delimiter) @syntax @feature
  (#set! liveMd.feature "syntax"))
((strikethrough) @mark.strike @feature
  (#set! liveMd.feature "inlineMark"))
((strong_emphasis) @mark.strong @feature
  (#set! liveMd.feature "inlineMark"))
((uri_autolink) @uriAutolink @feature
  (#set! liveMd.feature "autolink"))

((inline_link
  .
  (link_text) @link.text
  (link_destination)? @link.destination
  (link_title)?
  .) @link @feature
  (#set! liveMd.feature "link"))

((image
  .
  (image_description)? @image.description
  (link_destination)? @image.destination
  (link_title)?
  .) @image @feature
  (#set! liveMd.feature "image"))

((latex_block
  .
  (latex_span_delimiter) @latex.open
  (latex_span_delimiter) @latex.close
  .) @latex @feature
  (#set! liveMd.feature "latex"))
`;

const documentSearchHiddenQuery = `
[
  (atx_h1_marker)
  (atx_h2_marker)
  (atx_h3_marker)
  (atx_h4_marker)
  (atx_h5_marker)
  (atx_h6_marker)
  (setext_h1_underline)
  (setext_h2_underline)
  (block_continuation)
  (block_quote_marker)
  (fenced_code_block_delimiter)
  (link_reference_definition)
  (pipe_table_align_left)
  (pipe_table_align_right)
  (pipe_table_delimiter_cell)
  (pipe_table_delimiter_row)
  (task_list_marker_checked)
  (task_list_marker_unchecked)
  (thematic_break)
] @search.hidden

[
  (list_marker_dot)
  (list_marker_minus)
  (list_marker_parenthesis)
  (list_marker_plus)
  (list_marker_star)
] @search.hidden

(pipe_table (pipe_table_header "|" @search.hidden))
(pipe_table (pipe_table_delimiter_row "|" @search.hidden))
(pipe_table (pipe_table_row "|" @search.hidden))
`;

const inlineSearchHiddenQuery = `
[
  (code_span_delimiter)
  (emphasis_delimiter)
  (latex_span_delimiter)
  (link_destination)
  (link_title)
] @search.hidden

(inline_link ["[" "]" "(" ")"] @search.hidden)
(image ["!" "[" "]" "(" ")"] @search.hidden)
`;

function kitchenSinkDoc() {
  return (
    "# Heading One\n\n" +
    "Paragraph with _emphasis_, **bold**, ~~strike~~, `code`, [link](https://example.com), <https://example.com>, $x^2$.\n\n" +
    "> Quote line with **bold** and $y$.\n" +
    "> second quote line\n\n" +
    "- item one\n" +
    "- [x] done item\n" +
    "- [ ] todo item\n\n" +
    "---\n\n" +
    "![Alt image](https://example.com/image.png)\n\n" +
    "$$\n" +
    "E = mc^2\n" +
    "$$\n\n" +
    "| Name | Value |\n" +
    "| --- | ---: |\n" +
    "| alpha | 1 |\n" +
    "| beta | 2 |\n\n" +
    "```ts\n" +
    "type Note = { title: string; done: boolean };\n" +
    "const answer = 42;\n" +
    "console.log(answer);\n" +
    "```\n\n" +
    "After anchor line\n"
  );
}
