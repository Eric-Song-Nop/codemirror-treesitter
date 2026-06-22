import { EditorState } from "@codemirror/state";
import {
  type Tree,
  type TreeSitterQueryOptions,
  type TreeSitterQuerySource,
} from "@codemirror-treesitter/language";
import { loadMarkdownParserService } from "@codemirror-treesitter/language-data";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { analyzeMarkdownLeafSemantics } from "../src/core/analysis/markdown-leaf-analysis.js";
import { liveMdMarkdownInlineQuerySource } from "../src/core/analysis/query.js";
import { type DocRange } from "../src/core/analysis/types.js";
import { deleteLiveMdTree } from "../src/core/languages.js";

type QueryTreeCall = {
  options: TreeSitterQueryOptions | undefined;
  source: TreeSitterQuerySource;
  tree: Tree;
};

const queryTreeCalls = vi.hoisted(() => [] as QueryTreeCall[]);

vi.mock("@codemirror-treesitter/language", async (importOriginal) => {
  let actual = await importOriginal<typeof import("@codemirror-treesitter/language")>();
  return {
    ...actual,
    queryTreeMatches: (
      tree: Tree,
      source: TreeSitterQuerySource,
      options?: TreeSitterQueryOptions,
    ) => {
      queryTreeCalls.push({ options: options ? { ...options } : undefined, source, tree });
      return actual.queryTreeMatches(tree, source, options);
    },
  };
});

beforeEach(() => {
  queryTreeCalls.length = 0;
});

describe("LiveMD inline query bounds", () => {
  it("does not need inline fallback ranges for parser-service-backed Markdown hosts", async () => {
    let doc =
      "paragraph **bold**\n\n" +
      "- list **bold**\n\n" +
      "> quote **bold**\n\n" +
      "> - nested **bold**\n\n" +
      "# ATX **heading**\n\n" +
      "Setext _heading_\n" +
      "---\n\n" +
      "| Name | Value |\n" +
      "| --- | --- |\n" +
      "| **cell** | _two_ |\n\n" +
      "soft **line\n" +
      "continuation** text\n";
    let service = await loadMarkdownParserService();
    let state = EditorState.create({ doc });
    let tree = service.blockParser.parse(state.doc);
    try {
      let analysis = analyzeMarkdownLeafSemantics({ service, state, tree });

      expect(analysis.trace.inlineHostsWithoutRanges).toBe(0);
      expect(analysis.trace.inlineParseCalls).toBeGreaterThan(0);
      expect(analysis.trace.tableCellsParsed).toBe(4);
    } finally {
      deleteLiveMdTree(tree);
    }
  });

  it("passes explicit bounds to built-in inline queries for paragraphs, setext headings, and table cells", async () => {
    let doc =
      "paragraph **bold**\n\n" +
      "Setext _Heading_\n" +
      "---\n\n" +
      "> quoted **bold**\n" +
      "> continued _em_\n\n" +
      "| Name | Value |\n" +
      "| --- | --- |\n" +
      "| _alpha_ | **1** |\n";
    let service = await loadMarkdownParserService();
    let inlineRangeCalls: Array<DocRange | undefined> = [];
    let parsedRangeGroups: DocRange[][] = [];
    let inlineParser = Object.create(service.inlineParser) as typeof service.inlineParser;
    inlineParser.parseWith = (...args: Parameters<typeof service.inlineParser.parseWith>) => {
      let ranges = args[4];
      if (ranges)
        parsedRangeGroups.push(ranges.map((range) => ({ from: range.from, to: range.to })));
      return service.inlineParser.parseWith(...args);
    };
    let trackedService = {
      ...service,
      inlineParser,
      inlineRanges(tree: Tree, within?: DocRange) {
        inlineRangeCalls.push(within ? { from: within.from, to: within.to } : undefined);
        return service.inlineRanges(tree, within);
      },
    };
    let state = EditorState.create({ doc });
    let tree = service.blockParser.parse(state.doc);
    try {
      expect(
        analyzeMarkdownLeafSemantics({ service: trackedService, state, tree }).records.length,
      ).toBeGreaterThan(0);
    } finally {
      deleteLiveMdTree(tree);
    }

    let inlineCalls = queryTreeCalls.filter(
      (call) => call.source === liveMdMarkdownInlineQuerySource,
    );

    expect(inlineCalls.length).toBeGreaterThan(0);
    expect(inlineRangeCalls.length).toBeGreaterThan(0);
    for (let within of inlineRangeCalls) {
      expect(within).toBeTruthy();
      expect(typeof within!.from).toBe("number");
      expect(typeof within!.to).toBe("number");
      expect(within!.from).toBeGreaterThanOrEqual(0);
      expect(within!.to).toBeLessThanOrEqual(doc.length);
      expect(within!.from).toBeLessThanOrEqual(within!.to);
    }
    let parsedRanges = parsedRangeGroups.flat();
    expect(parsedRanges.length).toBeGreaterThan(0);
    let parsedRangeKeys = new Set(parsedRanges.map(rangeKey));
    for (let call of inlineCalls) {
      expect(call.options?.includeNested).toBe(false);
      expect(typeof call.options?.from).toBe("number");
      expect(typeof call.options?.to).toBe("number");
      expect(
        parsedRangeKeys.has(rangeKey({ from: call.options!.from!, to: call.options!.to! })),
      ).toBe(true);
    }

    let queriedTexts = inlineCalls.map((call) => doc.slice(call.options!.from!, call.options!.to!));
    let setextText = queriedTexts.find((text) => text.includes("_Heading_"));
    expect(queriedTexts).toContain("paragraph **bold**");
    expect(setextText).toBeTruthy();
    expect(setextText).not.toContain("---");
    expect(queriedTexts).toContain("_alpha_");
    expect(queriedTexts.some((text) => text.includes("continued _em_"))).toBe(true);
    expect(queriedTexts.some((text) => text.includes("> continued"))).toBe(false);
    expect(queriedTexts.some((text) => text.includes("---"))).toBe(false);
    expect(queriedTexts.some((text) => text == doc.slice(doc.indexOf("paragraph")))).toBe(false);
  });

  it("memoizes equivalent inline range groups for single-host paragraphs", async () => {
    let service = await loadMarkdownParserService();
    let cases = [
      { doc: "- item **bold**\n", name: "list paragraph" },
      { doc: "> quoted **bold**\n", name: "quoted paragraph" },
      { doc: "paragraph **bold**\n", name: "trailing newline paragraph" },
    ];

    for (let testCase of cases) {
      let parsedRangeGroups: DocRange[][] = [];
      let inlineParser = Object.create(service.inlineParser) as typeof service.inlineParser;
      inlineParser.parseWith = (...args: Parameters<typeof service.inlineParser.parseWith>) => {
        let ranges = args[4];
        if (ranges)
          parsedRangeGroups.push(ranges.map((range) => ({ from: range.from, to: range.to })));
        return service.inlineParser.parseWith(...args);
      };
      let trackedService = { ...service, inlineParser };
      let state = EditorState.create({ doc: testCase.doc });
      let tree = service.blockParser.parse(state.doc);
      try {
        let analysis = analyzeMarkdownLeafSemantics({ service: trackedService, state, tree });
        let normalizedRangeGroupKeys = new Set(parsedRangeGroups.map(normalizedRangeGroupKey));

        expect(analysis.trace.inlineParseCalls, testCase.name).toBe(1);
        expect(parsedRangeGroups, testCase.name).toHaveLength(1);
        expect(normalizedRangeGroupKeys.size, testCase.name).toBe(1);
      } finally {
        deleteLiveMdTree(tree);
      }
    }
  });

  it("returns empty inline descriptors when the parser service reports no inline ranges", async () => {
    let service = await loadMarkdownParserService();
    let inlineParser = Object.create(service.inlineParser) as typeof service.inlineParser;
    inlineParser.parseWith = () => {
      throw new Error("Inline parser must not parse without service-provided ranges");
    };
    let trackedService = {
      ...service,
      inlineParser,
      inlineRanges: () => [],
    };
    let doc = "paragraph **bold** [link](https://example.com) `code`\n";
    let state = EditorState.create({ doc });
    let tree = service.blockParser.parse(state.doc);
    try {
      let analysis = analyzeMarkdownLeafSemantics({ service: trackedService, state, tree });
      let paragraph = analysis.records.find((record) => record.kind == "paragraph");

      expect(analysis.trace.inlineHostsWithoutRanges).toBeGreaterThan(0);
      expect(analysis.trace.inlineParseCalls).toBe(0);
      expect(paragraph?.analysis.descriptors).toEqual([]);
    } finally {
      deleteLiveMdTree(tree);
    }
  });
});

function rangeKey(range: DocRange) {
  return `${range.from}:${range.to}`;
}

function normalizedRangeGroupKey(ranges: readonly DocRange[]) {
  return ranges.map(rangeKey).join("|");
}
