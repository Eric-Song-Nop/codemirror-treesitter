import { EditorState, StateEffect } from "@codemirror/state";
import { SearchQuery, getSearchQuery, setSearchQuery } from "@codemirror/search";
import { ensureSyntaxTree } from "@codemirror-treesitter/language";
import { loadMarkdownParserService } from "@codemirror-treesitter/language-data";
import { describe, expect, it } from "vite-plus/test";
import { liveMarkdown } from "../src/core/extension.js";
import { __testLiveMdAnalysis, liveMdAnalysis } from "../src/core/decorations.js";
import {
  liveMdMarkdownParserServiceFacet,
  loadMarkdownExtension,
  type LiveMdMarkdownParserService,
} from "../src/core/languages.js";
import { __testIsLiveMdSearchVisible, liveMdSearch } from "../src/core/search.js";

describe("LiveMD Markdown search", () => {
  it("treats rendered Markdown syntax as hidden search content", async () => {
    let doc = [
      "# Title",
      "",
      "Text with *emphasis* and [Label](https://hidden.example).",
      "![Alt text](image.png)",
      "<https://visible.example>",
      "| Head | Next |",
      "| --- | --- |",
      "| cell | value |",
    ].join("\n");
    let state = await markdownState(doc);

    expectRangeVisible(state, doc, "Title", true);
    expectRangeVisible(state, doc, "emphasis", true);
    expectRangeVisible(state, doc, "Label", true);
    expectRangeVisible(state, doc, "Alt text", true);
    expectRangeVisible(state, doc, "https://visible.example", true);
    expectRangeVisible(state, doc, "Head", true);
    expectRangeVisible(state, doc, "cell", true);

    expectRangeVisible(state, doc, "#", false);
    expectRangeVisible(state, doc, "*", false);
    expectRangeVisible(state, doc, "https://hidden.example", false);
    expectRangeVisible(state, doc, "image.png", false);
    expectRangeVisible(state, doc, "<", false);
    expectRangeVisible(state, doc, "---", false);
    expectRangeVisible(state, doc, "|", false);
  });

  it("filters CodeMirror search queries to visible Markdown ranges", async () => {
    let doc = "[Hidden target](https://hidden.example)\n<https://visible.example>";
    let state = await markdownState(doc);

    let hiddenTransaction = state.update({
      effects: setSearchQuery.of(new SearchQuery({ search: "https://hidden.example" })),
    });
    let hiddenQuery = getSearchQuery(hiddenTransaction.state);

    expect(collectMatches(hiddenTransaction.state, hiddenQuery)).toEqual([]);

    let visibleTransaction = state.update({
      effects: setSearchQuery.of(new SearchQuery({ search: "https://visible.example" })),
    });
    let visibleQuery = getSearchQuery(visibleTransaction.state);

    expect(collectMatches(visibleTransaction.state, visibleQuery)).toEqual([
      {
        from: doc.indexOf("https://visible.example"),
        to: doc.indexOf("https://visible.example") + "https://visible.example".length,
      },
    ]);
  });

  it("builds search visibility once per editor state", async () => {
    let doc = Array.from({ length: 20 }, () => "[target](https://target.example) target").join(
      "\n",
    );
    let counts = { createParser: 0, deleteParser: 0, inlineRanges: 0 };
    let service = countSearchParserService(await loadMarkdownParserService(), counts);
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(service),
        liveMdSearch,
      ],
    });
    ensureSyntaxTree(state, doc.length, 5_000);
    state = state.update({}).state.update({
      effects: setSearchQuery.of(new SearchQuery({ search: "target" })),
    }).state;
    let query = getSearchQuery(state);

    expect(collectMatches(state, query).length).toBeGreaterThan(0);
    expect(collectMatches(state, query).length).toBeGreaterThan(0);
    expect(counts.inlineRanges).toBe(1);
    expect(counts.createParser).toBe(1);
    expect(counts.deleteParser).toBe(1);
  });

  it("reuses scheduled semantics instead of synchronously parsing 10,000 inline hosts", async () => {
    let doc = Array.from({ length: 10_000 }, () => "*target*").join("\n\n");
    let counts = { createParser: 0, deleteParser: 0, inlineRanges: 0, parseWith: 0 };
    let service = countSearchParserService(await loadMarkdownParserService(), counts);
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(service),
        liveMdSearch,
      ],
    });
    ensureSyntaxTree(state, doc.length, 30_000);
    state = state.update({}).state;
    state = state.update({ effects: StateEffect.appendConfig.of(liveMdAnalysis) }).state;
    expect(__testLiveMdAnalysis({ state }).pending).toBeNull();
    expect(__testLiveMdAnalysis({ state }).semantic).not.toBeNull();
    counts.createParser = counts.deleteParser = counts.inlineRanges = counts.parseWith = 0;
    state = state.update({
      effects: setSearchQuery.of(new SearchQuery({ search: "target" })),
    }).state;

    expect(collectMatches(state, getSearchQuery(state))).toHaveLength(10_000);
    expect(counts.inlineRanges).toBeLessThanOrEqual(32);
    expect(counts.parseWith).toBe(0);
    expect(counts.createParser).toBe(0);
  }, 60_000);

  it("maps pending semantics and parses only the edited inline host", async () => {
    let doc = Array.from({ length: 10_000 }, () => "*target*").join("\n\n");
    let counts = { createParser: 0, deleteParser: 0, inlineRanges: 0, parseWith: 0 };
    let service = countSearchParserService(await loadMarkdownParserService(), counts);
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(service),
        liveMdSearch,
      ],
    });
    ensureSyntaxTree(state, doc.length, 30_000);
    state = state.update({}).state;
    state = state.update({ effects: StateEffect.appendConfig.of(liveMdAnalysis) }).state;
    state = state.update({ changes: { from: doc.length, insert: "x" } }).state;
    expect(__testLiveMdAnalysis({ state }).pending).not.toBeNull();
    counts.createParser = counts.deleteParser = counts.inlineRanges = counts.parseWith = 0;
    state = state.update({
      effects: setSearchQuery.of(new SearchQuery({ search: "target" })),
    }).state;

    expect(__testLiveMdAnalysis({ state }).pending).not.toBeNull();
    expect(collectMatches(state, getSearchQuery(state))).toHaveLength(10_000);
    expectRangeVisible(state, state.doc.toString(), "*", false);
    expect(counts.parseWith).toBeLessThanOrEqual(1);
    expect(counts.createParser).toBeLessThanOrEqual(1);
  }, 60_000);

  it("keeps many pending edits off the synchronous search path", async () => {
    let doc = Array.from({ length: 10_000 }, () => "*target*").join("\n\n");
    let counts = { createParser: 0, deleteParser: 0, inlineRanges: 0, parseWith: 0 };
    let service = countSearchParserService(await loadMarkdownParserService(), counts);
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(service),
        liveMdSearch,
      ],
    });
    ensureSyntaxTree(state, doc.length, 30_000);
    state = state.update({}).state;
    state = state.update({ effects: StateEffect.appendConfig.of(liveMdAnalysis) }).state;
    state = state.update({
      effects: setSearchQuery.of(new SearchQuery({ search: "target" })),
    }).state;
    counts.createParser = counts.deleteParser = counts.inlineRanges = counts.parseWith = 0;
    state = state.update({
      changes: Array.from({ length: 128 }, (_, index) => ({
        from: index * 700,
        insert: "x",
      })),
    }).state;
    expect(__testLiveMdAnalysis({ state }).pending).not.toBeNull();
    ensureSyntaxTree(state, state.doc.length, 30_000);

    expect(collectMatches(state, getSearchQuery(state))).toHaveLength(10_000);
    expect(counts.parseWith).toBe(0);
    expect(counts.createParser).toBe(0);
  }, 60_000);

  it("does not synchronously reparse the document before the first scheduled commit", async () => {
    let doc = Array.from({ length: 10_000 }, () => "*target*").join("\n\n");
    let counts = { createParser: 0, deleteParser: 0, inlineRanges: 0, parseWith: 0 };
    let service = countSearchParserService(await loadMarkdownParserService(), counts);
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(service),
        liveMdSearch,
        liveMdAnalysis,
      ],
    });
    ensureSyntaxTree(state, doc.length, 30_000);
    state = state.update({}).state;
    expect(__testLiveMdAnalysis({ state }).pending).not.toBeNull();
    counts.createParser = counts.deleteParser = counts.inlineRanges = counts.parseWith = 0;
    state = state.update({
      effects: setSearchQuery.of(new SearchQuery({ search: "target" })),
    }).state;

    expect(collectMatches(state, getSearchQuery(state))).toHaveLength(10_000);
    expect(counts.parseWith).toBe(0);
    expect(counts.createParser).toBe(0);
  }, 60_000);

  it("preserves rendered-source visibility when using committed semantics", async () => {
    let doc = [
      "# Title",
      "",
      "Text with *emphasis* and [Label](https://hidden.example).",
      "![Alt text](image.png)",
      "<https://visible.example>",
    ].join("\n");
    let counts = { createParser: 0, deleteParser: 0, inlineRanges: 0, parseWith: 0 };
    let service = countSearchParserService(await loadMarkdownParserService(), counts);
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(service),
        liveMdSearch,
      ],
    });
    ensureSyntaxTree(state, doc.length, 5_000);
    state = state.update({}).state;
    state = state.update({ effects: StateEffect.appendConfig.of(liveMdAnalysis) }).state;
    counts.createParser = counts.deleteParser = counts.inlineRanges = counts.parseWith = 0;

    expectRangeVisible(state, doc, "emphasis", true);
    expectRangeVisible(state, doc, "Label", true);
    expectRangeVisible(state, doc, "Alt text", true);
    expectRangeVisible(state, doc, "https://visible.example", true);
    expectRangeVisible(state, doc, "*", false);
    expectRangeVisible(state, doc, "https://hidden.example", false);
    expectRangeVisible(state, doc, "image.png", false);
    expectRangeVisible(state, doc, "<", false);
    expect(counts.parseWith).toBe(0);
  });
});

async function markdownState(doc: string) {
  let state = EditorState.create({
    doc,
    extensions: [await loadMarkdownExtension(), liveMarkdown()],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state.update({}).state;
}

function expectRangeVisible(state: EditorState, doc: string, needle: string, expected: boolean) {
  let from = doc.indexOf(needle);
  expect(from, needle).toBeGreaterThanOrEqual(0);
  expect(__testIsLiveMdSearchVisible(state, from, from + needle.length), needle).toBe(expected);
}

function collectMatches(state: EditorState, query: SearchQuery) {
  let matches: Array<{ from: number; to: number }> = [];
  for (
    let cursor = query.getCursor(state), next = cursor.next();
    !next.done;
    next = cursor.next()
  ) {
    matches.push({ from: next.value.from, to: next.value.to });
  }
  return matches;
}

function countSearchParserService(
  service: LiveMdMarkdownParserService,
  counts: { createParser: number; deleteParser: number; inlineRanges: number; parseWith?: number },
): LiveMdMarkdownParserService {
  let inlineParser = Object.create(
    service.inlineParser,
  ) as LiveMdMarkdownParserService["inlineParser"];
  inlineParser.createParser = () => {
    counts.createParser++;
    let parser = service.inlineParser.createParser();
    let nativeParser = parser as { delete: () => void };
    let deleteParser = nativeParser.delete.bind(parser);
    nativeParser.delete = () => {
      counts.deleteParser++;
      deleteParser();
    };
    return parser;
  };
  inlineParser.parseWith = (...args) => {
    if (counts.parseWith != null) counts.parseWith++;
    return service.inlineParser.parseWith(...args);
  };
  return {
    ...service,
    inlineParser,
    inlineRanges(tree, within) {
      counts.inlineRanges++;
      return service.inlineRanges(tree, within);
    },
  };
}
