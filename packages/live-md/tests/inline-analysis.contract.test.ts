// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import {
  EditorState,
  __testBuildLiveMdAnalysis,
  analyzeMarkdownLeafSemantics,
  canonicalAnalysis,
  codeFenceLanguagesField,
  deleteLiveMdTree,
  ensureSyntaxTree,
  installAnalysisTestEnvironment,
  liveMdMarkdownParserServiceFacet,
  loadMarkdownParserService,
  rangesOverlap,
} from "./helpers/analysis.js";
import type { DocRange } from "./helpers/analysis.js";

installAnalysisTestEnvironment();

describe("LiveMD inline analysis contract", () => {
  it("balances leaf-local inline parser and tree lifetimes including table cells", async () => {
    let service = await loadMarkdownParserService();
    let created = 0;
    let deleted = 0;
    let createdTrees = 0;
    let deletedTrees = 0;
    let parsedRanges: DocRange[][] = [];
    let inlineParser = Object.create(service.inlineParser) as typeof service.inlineParser;
    inlineParser.createParser = () => {
      created++;
      let parser = service.inlineParser.createParser();
      let deleteParser = parser.delete.bind(parser);
      parser.delete = () => {
        deleted++;
        deleteParser();
      };
      return parser;
    };
    inlineParser.parseWith = (...args: Parameters<typeof service.inlineParser.parseWith>) => {
      let ranges = args[4];
      if (ranges) parsedRanges.push(ranges.map((range) => ({ from: range.from, to: range.to })));
      return service.inlineParser.parseWith(...args);
    };
    inlineParser.wrapTree = (...args: Parameters<typeof service.inlineParser.wrapTree>) => {
      let tree = service.inlineParser.wrapTree(...args);
      if (tree?.tree) {
        createdTrees++;
        let wrappedTree = tree.tree;
        let deleteTree = wrappedTree.delete.bind(wrappedTree);
        wrappedTree.delete = () => {
          deletedTrees++;
          deleteTree();
        };
      }
      return tree;
    };
    let trackedService = { ...service, inlineParser };
    let doc =
      "one **two**\n\n" +
      "| Name | Value |\n" +
      "| --- | --- |\n" +
      "| _alpha_ | **1** |\n\n" +
      "three _four_\n\n" +
      "![Alt](image.png)\n";
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(trackedService),
        codeFenceLanguagesField,
      ],
    });
    ensureSyntaxTree(state, doc.length, 5_000);

    let analysis = __testBuildLiveMdAnalysis(state);

    expect(created).toBe(1);
    expect(deleted).toBe(created);
    expect(createdTrees).toBeGreaterThan(0);
    expect(deletedTrees).toBe(createdTrees);
    expect(analysis.trace.inlineParserSessions).toBe(1);
    expect(analysis.trace.inlineParseCalls).toBe(parsedRanges.length);
    expect(analysis.trace.inlineParsedChars).toBeGreaterThan(0);
    expect(analysis.trace.recordsVisited).toBeGreaterThan(0);
    expect(analysis.trace.recordsAnalyzed).toBe(analysis.trace.recordsVisited);
    expect(analysis.trace.tableCellsParsed).toBe(4);
    expect(parsedRanges.flat().some((range) => doc.slice(range.from, range.to) == "_alpha_")).toBe(
      true,
    );
  });

  it("keeps inline range group examination linear for many paragraphs", async () => {
    let service = await loadMarkdownParserService();
    let doc =
      Array.from({ length: 10_000 }, (_value, index) => `paragraph ${index} **bold**`).join(
        "\n\n",
      ) + "\n";
    let state = EditorState.create({ doc });
    let tree = service.blockParser.parse(state.doc);
    try {
      let analysis = analyzeMarkdownLeafSemantics({ service, state, tree });
      let trace = analysis.trace as typeof analysis.trace & {
        inlineRangeGroupsExamined: number;
      };

      expect(analysis.records).toHaveLength(10_000);
      expect(trace.recordsAnalyzed).toBe(10_000);
      expect(typeof trace.inlineRangeGroupsExamined).toBe("number");
      expect(trace.inlineRangeGroupsExamined).toBeGreaterThan(0);
      expect(trace.inlineRangeGroupsExamined).toBeLessThanOrEqual(trace.recordsAnalyzed + 2);
      expect(trace.inlineHostsWithoutRanges).toBe(0);
    } finally {
      deleteLiveMdTree(tree);
    }
  }, 60_000);

  it("keeps raw inline Markdown visible when the parser service reports no inline ranges", async () => {
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
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(trackedService),
        codeFenceLanguagesField,
      ],
    });
    ensureSyntaxTree(state, doc.length, 5_000);

    let analysis = __testBuildLiveMdAnalysis(state);

    expect(analysis.trace.inlineHostsWithoutRanges).toBeGreaterThan(0);
    expect(analysis.trace.inlineParseCalls).toBe(0);
    expect(canonicalAnalysis(state, analysis)).toEqual({ atomicRanges: [], decorations: [] });
  });

  it("releases inline parser and parsed tree when inline wrapping throws", async () => {
    let service = await loadMarkdownParserService();
    let created = 0;
    let deleted = 0;
    let parsedTreeDeletes = 0;
    let inlineParser = Object.create(service.inlineParser) as typeof service.inlineParser;
    inlineParser.createParser = () => {
      created++;
      let parser = service.inlineParser.createParser();
      let deleteParser = parser.delete.bind(parser);
      parser.delete = () => {
        deleted++;
        deleteParser();
      };
      return parser;
    };
    inlineParser.parseWith = (...args: Parameters<typeof service.inlineParser.parseWith>) => {
      let parsed = service.inlineParser.parseWith(...args);
      if (parsed) {
        let deleteParsed = parsed.delete.bind(parsed);
        parsed.delete = () => {
          parsedTreeDeletes++;
          deleteParsed();
        };
      }
      return parsed;
    };
    inlineParser.wrapTree = () => {
      throw new Error("inline wrap failed");
    };
    let trackedService = { ...service, inlineParser };
    let doc = "one **two**\n";
    let state = EditorState.create({
      doc,
      extensions: [
        service.blockLanguage.extension,
        liveMdMarkdownParserServiceFacet.of(trackedService),
        codeFenceLanguagesField,
      ],
    });
    ensureSyntaxTree(state, doc.length, 5_000);

    expect(() => __testBuildLiveMdAnalysis(state)).toThrow("inline wrap failed");
    expect(created).toBe(1);
    expect(deleted).toBe(1);
    expect(parsedTreeDeletes).toBe(1);
  });

  it("parses setext heading inline content without parsing the underline", async () => {
    let service = await loadMarkdownParserService();
    let parsedRanges: DocRange[][] = [];
    let inlineParser = Object.create(service.inlineParser) as typeof service.inlineParser;
    inlineParser.parseWith = (...args: Parameters<typeof service.inlineParser.parseWith>) => {
      let ranges = args[4];
      if (ranges) parsedRanges.push(ranges.map((range) => ({ from: range.from, to: range.to })));
      return service.inlineParser.parseWith(...args);
    };
    let trackedService = { ...service, inlineParser };
    let doc = "Setext **Heading**\n---\n\nnext";
    let state = EditorState.create({ doc });
    let tree = service.blockParser.parse(state.doc);
    try {
      analyzeMarkdownLeafSemantics({ service: trackedService, state, tree });
    } finally {
      deleteLiveMdTree(tree);
    }

    let underline = { from: doc.indexOf("---"), to: doc.indexOf("---") + 3 };
    expect(
      parsedRanges.flat().some((range) => doc.slice(range.from, range.to).includes("**")),
    ).toBe(true);
    expect(parsedRanges.flat().some((range) => rangesOverlap(range, underline))).toBe(false);
  });

  it("skips analysis for leaves with descendant ERROR or MISSING nodes", async () => {
    let service = await loadMarkdownParserService();
    let doc = "| a | b |\n| --- | ---\n||";
    let state = EditorState.create({ doc });
    let tree = service.blockParser.parse(state.doc);
    try {
      let tableRecord = analyzeMarkdownLeafSemantics({ service, state, tree }).records.find(
        (record) => record.kind == "table",
      );

      expect(tableRecord?.analysis.descriptors).toEqual([]);
    } finally {
      deleteLiveMdTree(tree);
    }
  });
});
