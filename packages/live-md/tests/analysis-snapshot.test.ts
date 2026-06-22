// @vitest-environment happy-dom

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  ensureSyntaxTree,
  HighlightStyle,
  syntaxHighlighting,
  tags as t,
  Tree,
  type DocRange,
} from "@codemirror-treesitter/language";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  __testBuildCanonicalLiveMdAnalysis,
  __testBuildLiveMdAnalysis,
  __testLiveMdAnalysis,
  liveMdAnalysis,
} from "../src/core/decorations.js";
import { liveMdMarkdownFeatures } from "../src/core/features.js";
import { liveMdImageSource, normalizeMarkdownImageSource } from "../src/core/images.js";
import { analyzeMarkdownLeafSemantics } from "../src/core/analysis/markdown-leaf-analysis.js";
import {
  codeFenceLanguagesField,
  deleteLiveMdTree,
  liveMdCodeFenceHighlighting,
  loadCodeFenceLanguages,
  loadMarkdownExtension,
  liveMdMarkdownParserServiceFacet,
  setCodeFenceLanguages,
} from "../src/core/languages.js";
import { loadMarkdownParserService } from "@codemirror-treesitter/language-data";

let locationDescriptor: PropertyDescriptor | undefined;

const testLightCodeFenceHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#0969da" },
]);

const testDarkCodeFenceHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#f5a97f" },
]);

beforeEach(() => {
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  document.body.replaceChildren();
  if (locationDescriptor) {
    Object.defineProperty(globalThis, "location", locationDescriptor);
  }
});

describe("LiveMD analysis snapshot", () => {
  it("builds decorations through query captures without tree iteration", async () => {
    let state = await markdownAnalysisState(liveMdKitchenSinkDoc(), "After anchor");
    expect(canonicalAnalysis(state).decorations.length).toBeGreaterThan(0);
    let iterateDescriptor = Object.getOwnPropertyDescriptor(Tree.prototype, "iterate")!;

    Object.defineProperty(Tree.prototype, "iterate", {
      configurable: true,
      value: () => {
        throw new Error("LiveMD analysis should use tree-sitter queries");
      },
    });
    try {
      expect(
        canonicalAnalysis(state, __testBuildLiveMdAnalysis(state)).decorations.length,
      ).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(Tree.prototype, "iterate", iterateDescriptor);
    }
  });

  it("keeps full-document analysis equivalent after edits", async () => {
    let view = await markdownAnalysisView(liveMdKitchenSinkDoc(), "After anchor");
    let editFrom = view.state.doc.toString().indexOf("alpha | 1");
    let transaction = view.state.update({
      changes: {
        from: editFrom,
        insert: "alpha | 9",
        to: editFrom + "alpha | 1".length,
      },
    });
    ensureSyntaxTree(transaction.state, transaction.state.doc.length, 5_000);

    view.dispatch(transaction);

    expect(canonicalAnalysis(view.state, __testLiveMdAnalysis(view))).toEqual(
      canonicalAnalysis(view.state, __testBuildCanonicalLiveMdAnalysis(view.state)),
    );
    view.destroy();
  });

  it("keeps full-document analysis equivalent after selection-only updates", async () => {
    let view = await markdownAnalysisView(liveMdKitchenSinkDoc(), "After anchor");

    for (let target of ["Heading One", "Alt image", "E = mc^2", "After anchor"]) {
      view.dispatch({
        selection: { anchor: view.state.doc.toString().indexOf(target) },
      });

      expect(canonicalAnalysis(view.state, __testLiveMdAnalysis(view)), target).toEqual(
        canonicalAnalysis(view.state, __testBuildCanonicalLiveMdAnalysis(view.state)),
      );
    }
    view.destroy();
  });

  it("keeps leaf-local projection equivalent to the canonical full-query projection", async () => {
    let docs = [
      liveMdKitchenSinkDoc(),
      "![Alt](image.png)\n\n| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n\n```mermaid\ngraph TD\nA-->B\n```\n",
      "> - [ ] quoted task\n>\n> paragraph with **bold**\n\n---\n",
    ];

    for (let doc of docs) {
      let state = await markdownAnalysisState(doc);

      expect(canonicalAnalysis(state, __testBuildLiveMdAnalysis(state))).toEqual(
        canonicalAnalysis(state, __testBuildCanonicalLiveMdAnalysis(state)),
      );
    }
  });

  it("keeps active table inline projection equivalent to the canonical full-query projection", async () => {
    let doc =
      "before\n\n" +
      "| Name | Value |\n" +
      "| --- | ---: |\n" +
      "| _alpha_ | **1** |\n" +
      "| [beta](https://example.com) | `2` |\n\n" +
      "after\n";
    let state = await markdownAnalysisState(doc, "_alpha_");
    let leafLocal = __testBuildLiveMdAnalysis(state);

    expect(canonicalAnalysis(state, leafLocal)).toEqual(
      canonicalAnalysis(state, __testBuildCanonicalLiveMdAnalysis(state)),
    );
    expect(decorationClasses(state, leafLocal).has("cm-md-emphasis")).toBe(true);
    expect(decorationClasses(state, leafLocal).has("cm-md-strong")).toBe(true);
    expect(decorationClasses(state, leafLocal).has("cm-md-inline-code")).toBe(true);
  });

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

  it("renders table previews for a larger README table", async () => {
    let doc =
      "before\n\n" +
      "## Workspace Structure\n\n" +
      "| Path              | Purpose                                                                                               |\n" +
      "| ----------------- | ----------------------------------------------------------------------------------------------------- |\n" +
      "| `package.json`    | Private Bun/Vite+ workspace, catalog versions, root scripts, and engine constraints.                  |\n" +
      "| `vite.config.ts`  | Shared Vite+ config for aliases, formatting, linting, type-aware checks, and run caching.             |\n" +
      "| `vite.shared.ts`  | Workspace import aliases used by packages and apps during local development.                          |\n" +
      "| `tsconfig*.json`  | Shared TypeScript settings for package and app builds.                                                |\n" +
      "| `packages/*`      | Workspace `@codemirror-treesitter/*` implementation and experimental packages.                        |\n" +
      "| `apps/*`          | Local browser, benchmark, comparison, Grove, relay, demo, and Cloudflare collaboration apps.          |\n" +
      "| `tools/audit.mjs` | Repository audit for package names, Lezer-free boundaries, upstream parity, coverage, and app wiring. |\n" +
      "| `bun.lock`        | Bun lockfile generated by `vp install`.                                                               |\n\n" +
      "after\n";
    let state = await markdownAnalysisState(doc, "Workspace Structure");
    let tables = tablePreviewTables(state);

    expect(tables).toHaveLength(1);
    expect(tables[0]?.header).toEqual(["Path", "Purpose"]);
    expect(tables[0]?.rows).toHaveLength(8);
    expect(tables[0]?.rows.at(-1)?.[0]).toBe("`bun.lock`");
  });

  it("keeps README-style escaped pipes inside table cells", async () => {
    let doc =
      "## Element API\n\n" +
      "| Property     | Type                 | Description                                |\n" +
      "| ------------ | -------------------- | ------------------------------------------ |\n" +
      "| `persistKey` | `string \\| null`     | `localStorage` key, read/write.            |\n" +
      "| `view`       | `EditorView \\| null` | The underlying CodeMirror `EditorView`.    |\n\n" +
      "after\n";
    let state = await markdownAnalysisState(doc, "Element API");
    let tables = tablePreviewTables(state);

    expect(tables).toHaveLength(1);
    expect(tables[0]?.rows[0]).toEqual([
      "`persistKey`",
      "`string \\| null`",
      "`localStorage` key, read/write.",
    ]);
    expect(tables[0]?.rows[1]).toEqual([
      "`view`",
      "`EditorView \\| null`",
      "The underlying CodeMirror `EditorView`.",
    ]);
  });

  it("parses code fence highlights after edits", async () => {
    let doc = "```html\n<script>let a = 1;</script>\n```\n";
    let parseCalls = 0;
    let parserCreate = 0;
    let parserDelete = 0;
    let nestedOwnerMaps = 0;
    let nestedParserCreate = 0;
    let nestedParserDelete = 0;
    let treeCreate = 0;
    let treeDelete = 0;
    let languages = new Map(await loadCodeFenceLanguages());
    let htmlParser = languages.get("html");
    if (!htmlParser) throw new Error("HTML code fence parser is unavailable");
    let trackedParser = Object.create(htmlParser) as typeof htmlParser;
    trackedParser.createParser = () => {
      parserCreate++;
      let parser = htmlParser.createParser();
      let deleteParser = parser.delete.bind(parser);
      parser.delete = () => {
        parserDelete++;
        deleteParser();
      };
      return parser;
    };
    trackedParser.parseWith = (...args: Parameters<typeof htmlParser.parseWith>) => {
      parseCalls++;
      return htmlParser.parseWith(...args);
    };
    trackedParser.wrapTree = (...args: Parameters<typeof htmlParser.wrapTree>) => {
      let nestedParsers = args[4];
      if (!nestedParsers) throw new Error("Expected code fence nested parser owner map");
      let tree = htmlParser.wrapTree(...args);
      nestedOwnerMaps++;
      nestedParserCreate += nestedParsers.size;
      for (let parser of nestedParsers.values()) {
        let deleteParser = parser.delete.bind(parser);
        parser.delete = () => {
          nestedParserDelete++;
          deleteParser();
        };
      }
      if (tree) treeCreate += trackNativeTreeDeletes(tree, () => treeDelete++);
      return tree;
    };
    languages.set("html", trackedParser);

    let view = await markdownAnalysisView(doc);
    view.dispatch({ effects: setCodeFenceLanguages.of(languages) });
    let initialAnalysis = __testLiveMdAnalysis(view);
    expect(parseCalls).toBe(1);
    expect(parserCreate).toBe(1);
    expect(nestedOwnerMaps).toBe(1);
    expect(nestedParserCreate).toBeGreaterThan(0);
    expect(parserDelete).toBe(1);
    expect(nestedParserDelete).toBe(nestedParserCreate);
    expect(treeCreate).toBeGreaterThan(1);
    expect(treeDelete).toBe(treeCreate);
    expect(initialAnalysis.trace.codeFenceParserSessionsCreated).toBe(
      parserCreate + nestedParserCreate,
    );
    expect(initialAnalysis.trace.codeFenceParserSessionsDeleted).toBe(
      parserDelete + nestedParserDelete,
    );
    expect(initialAnalysis.trace.codeFenceTreesCreated).toBe(treeCreate);
    expect(initialAnalysis.trace.codeFenceTreesDeleted).toBe(treeDelete);

    parseCalls = 0;
    parserCreate = 0;
    parserDelete = 0;
    nestedOwnerMaps = 0;
    nestedParserCreate = 0;
    nestedParserDelete = 0;
    treeCreate = 0;
    treeDelete = 0;
    let editFrom = doc.indexOf("a = 1");
    view.dispatch({
      changes: { from: editFrom, to: editFrom + 1, insert: "aa" },
    });

    let editedAnalysis = __testLiveMdAnalysis(view);
    expect(parseCalls).toBe(1);
    expect(parserCreate).toBe(1);
    expect(nestedOwnerMaps).toBe(1);
    expect(nestedParserCreate).toBeGreaterThan(0);
    expect(parserDelete).toBe(1);
    expect(nestedParserDelete).toBe(nestedParserCreate);
    expect(treeCreate).toBeGreaterThan(1);
    expect(treeDelete).toBe(treeCreate);
    expect(editedAnalysis.trace.codeFenceParserSessionsCreated).toBe(
      parserCreate + nestedParserCreate,
    );
    expect(editedAnalysis.trace.codeFenceParserSessionsDeleted).toBe(
      parserDelete + nestedParserDelete,
    );
    expect(editedAnalysis.trace.codeFenceTreesCreated).toBe(treeCreate);
    expect(editedAnalysis.trace.codeFenceTreesDeleted).toBe(treeDelete);
    view.destroy();
  });

  it("reuses active syntax highlighters for code fence highlights", async () => {
    let highlighterCompartment = new Compartment();
    let view = await markdownAnalysisView("```ts\nlet answer = 1;\n```\n", "", [
      highlighterCompartment.of(syntaxHighlighting(testLightCodeFenceHighlightStyle)),
    ]);
    view.dispatch({ effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()) });
    let lightKeywordClass = testLightCodeFenceHighlightStyle.style([t.keyword]);
    let darkKeywordClass = testDarkCodeFenceHighlightStyle.style([t.keyword]);

    expect(lightKeywordClass).toBeTruthy();
    expect(darkKeywordClass).toBeTruthy();
    expect(codeFenceClasses(view.state).has(lightKeywordClass!)).toBe(true);

    view.dispatch({
      effects: highlighterCompartment.reconfigure(
        syntaxHighlighting(testDarkCodeFenceHighlightStyle),
      ),
    });

    expect(codeFenceClasses(view.state).has(darkKeywordClass!)).toBe(true);
    expect(codeFenceClasses(view.state).has(lightKeywordClass!)).toBe(false);
    view.destroy();
  });

  it("allows explicit code fence highlighter overrides", async () => {
    let view = await markdownAnalysisView("```ts\nlet answer = 1;\n```\n", "", [
      syntaxHighlighting(testLightCodeFenceHighlightStyle),
      liveMdCodeFenceHighlighting(testDarkCodeFenceHighlightStyle),
    ]);
    view.dispatch({ effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()) });
    let lightKeywordClass = testLightCodeFenceHighlightStyle.style([t.keyword]);
    let darkKeywordClass = testDarkCodeFenceHighlightStyle.style([t.keyword]);

    expect(darkKeywordClass).toBeTruthy();
    expect(codeFenceClasses(view.state).has(darkKeywordClass!)).toBe(true);
    expect(codeFenceClasses(view.state).has(lightKeywordClass!)).toBe(false);
    view.destroy();
  });

  it("decorates inline markdown at EOF", async () => {
    let doc = "cursor here\n\nuse *emphasize* here";
    let state = await markdownAnalysisState(doc);
    let decorations = canonicalAnalysis(state).decorations;
    let emphasisFrom = doc.indexOf("*emphasize*");
    let emphasisTo = emphasisFrom + "*emphasize*".length;

    expect(
      decorations.some(
        (decoration) =>
          decoration.from == emphasisFrom &&
          decoration.to == emphasisTo &&
          (decoration.spec as { class?: string }).class == "cm-md-emphasis",
      ),
    ).toBe(true);
  });

  it("renders table previews at EOF without a trailing newline", async () => {
    let doc = "before\n\n| Name | Value |\n| --- | ---: |\n| alpha | 1 |";
    let view = await markdownAnalysisView(doc, "before");
    let table = view.contentDOM.querySelector(".cm-md-table-preview table");

    expect(table?.textContent).toContain("Name");
    expect(table?.textContent).toContain("alpha");
    view.destroy();
  });

  it("keeps table source editable on the trailing blank line", async () => {
    let doc = "| Name | Value |\n| --- | ---: |\n";
    let view = await markdownAnalysisView(doc);

    expect(view.contentDOM.querySelector(".cm-md-table-preview")).toBeNull();
    expect(view.contentDOM.textContent).toContain("| Name | Value |");
    view.destroy();
  });

  it("renders task list decorations at EOF without a trailing newline", async () => {
    let doc = "- [x] done\n- [ ] todo";
    let view = await markdownAnalysisView(doc, "done");

    expect(view.contentDOM.querySelectorAll(".cm-md-list-line")).toHaveLength(2);
    expect(view.contentDOM.querySelectorAll(".cm-md-task-line")).toHaveLength(2);
    expect(view.contentDOM.querySelectorAll(".cm-md-task-toggle")).toHaveLength(1);
    view.destroy();
  });

  it("renders task list decorations before trailing EOF blank lines", async () => {
    let doc = "- [x] done\n- [ ] todo\n\n\n";
    let state = (await markdownAnalysisState(doc)).update({
      selection: { anchor: doc.length },
    }).state;
    let decorations = canonicalAnalysis(state).decorations;

    expect(
      decorations.filter(
        (decoration) =>
          (decoration.spec as { widget?: { name?: string } }).widget?.name == "TaskCheckboxWidget",
      ),
    ).toHaveLength(2);
  });

  it("renders table previews before trailing EOF blank lines", async () => {
    let doc = "| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n\n\n";
    let state = (await markdownAnalysisState(doc)).update({
      selection: { anchor: doc.length },
    }).state;
    let decorations = canonicalAnalysis(state).decorations;

    expect(
      decorations.some(
        (decoration) =>
          (decoration.spec as { widget?: { name?: string } }).widget?.name == "TablePreviewWidget",
      ),
    ).toBe(true);
  });

  it("normalizes Markdown image destinations for preview widgets", async () => {
    expect(normalizeMarkdownImageSource("</asset/icon.svg>")).toBe("/asset/icon.svg");
    expect(normalizeMarkdownImageSource("/images/photo\\(copy\\).png")).toBe(
      "/images/photo(copy).png",
    );

    let doc =
      "![Angle](</asset/icon.svg>)\n\n" + "![Escaped](/images/photo\\(copy\\).png)\n\n" + "after";
    let state = await markdownAnalysisState(doc, "after");

    expect(imagePreviewSources(state)).toEqual(["/asset/icon.svg", "/images/photo(copy).png"]);
  });

  it("rebuilds image previews when the image source resolver changes", async () => {
    let imageSourceCompartment = new Compartment();
    let view = await markdownAnalysisView("![Local](assets/local.png)\n\nafter", "after", [
      imageSourceCompartment.of(liveMdImageSource((source) => `blob:first/${source}`)),
    ]);

    expect(imagePreviewSources(view.state)).toEqual(["blob:first/assets/local.png"]);

    view.dispatch({
      effects: imageSourceCompartment.reconfigure(
        liveMdImageSource((source) => `blob:second/${source}`),
      ),
    });

    expect(imagePreviewSources(view.state)).toEqual(["blob:second/assets/local.png"]);
    view.destroy();
  });

  it("allows markdown features to add query-driven decorations", async () => {
    let state = await markdownAnalysisState("# First\n\n# Second\n", "", [
      liveMdMarkdownFeatures([
        {
          name: "test-heading",
          query: "(atx_heading) @heading",
          decorate({ addLineClass, addMark, node }) {
            let heading = node("heading");
            if (!heading) return;
            addLineClass(heading.from, heading.to, "cm-md-feature-heading-line");
            addMark(heading.from, heading.to, "cm-md-feature-heading");
          },
        },
      ]),
    ]);

    expect(decorationClasses(state).has("cm-md-feature-heading")).toBe(true);
    expect(decorationClasses(state).has("cm-md-feature-heading-line")).toBe(true);
  });

  it("rebuilds markdown feature decorations when features change", async () => {
    let featureCompartment = new Compartment();
    let view = await markdownAnalysisView("# Dynamic\n\nbody", "body", [
      featureCompartment.of(markHeadingFeature("cm-md-feature-first")),
    ]);

    expect(decorationClasses(view.state).has("cm-md-feature-first")).toBe(true);
    expect(decorationClasses(view.state).has("cm-md-feature-second")).toBe(false);

    view.dispatch({
      effects: featureCompartment.reconfigure(markHeadingFeature("cm-md-feature-second")),
    });

    expect(decorationClasses(view.state).has("cm-md-feature-first")).toBe(false);
    expect(decorationClasses(view.state).has("cm-md-feature-second")).toBe(true);
    view.destroy();
  });
});

async function markdownAnalysisState(doc: string, selectionText = "", extensions: Extension = []) {
  let selection = selectionText ? doc.indexOf(selectionText) : 0;
  let state = EditorState.create({
    doc,
    extensions: [
      await loadMarkdownExtension(),
      codeFenceLanguagesField,
      extensions,
      liveMdAnalysis,
    ],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state.update({ selection: { anchor: selection } }).state;
}

async function markdownAnalysisView(doc: string, selectionText = "", extensions: Extension = []) {
  let selection = selectionText ? doc.indexOf(selectionText) : 0;
  let view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc,
      selection: { anchor: selection },
      extensions: [
        await loadMarkdownExtension(),
        codeFenceLanguagesField,
        extensions,
        liveMdAnalysis,
      ],
    }),
  });
  ensureSyntaxTree(view.state, doc.length, 5_000);
  view.dispatch({});
  return view;
}

function imagePreviewSources(state: EditorState) {
  let sources: string[] = [];
  __testBuildLiveMdAnalysis(state).decorations.between(0, state.doc.length, (_from, _to, value) => {
    let widget = (value.spec as { widget?: unknown }).widget;
    if (widget && widget.constructor.name == "ImagePreviewWidget") {
      sources.push((widget as { src: string }).src);
    }
  });
  return sources;
}

type TestMarkdownTable = {
  alignments: string[];
  header: string[];
  rows: string[][];
};

function tablePreviewTables(
  state: EditorState,
  analysis = __testBuildLiveMdAnalysis(state),
): TestMarkdownTable[] {
  let tables: TestMarkdownTable[] = [];
  analysis.decorations.between(0, state.doc.length, (_from, _to, value) => {
    let widget = (value.spec as { widget?: unknown }).widget;
    if (widget && widget.constructor.name == "TablePreviewWidget") {
      tables.push((widget as { table: TestMarkdownTable }).table);
    }
  });
  return tables;
}

function codeFenceClasses(state: EditorState) {
  let classes = new Set<string>();
  __testLiveMdAnalysis({ state } as EditorView).decorations.between(
    0,
    state.doc.length,
    (_from, _to, value) => {
      let className = (value.spec as { class?: string }).class;
      if (className) classes.add(className);
    },
  );
  return classes;
}

function trackNativeTreeDeletes(tree: Tree, onDelete: () => void): number {
  let count = 0;
  if (tree.tree) {
    count++;
    let wrappedTree = tree.tree;
    let deleteTree = wrappedTree.delete.bind(wrappedTree);
    wrappedTree.delete = () => {
      onDelete();
      deleteTree();
    };
  }
  for (let nested of tree.nested) {
    count += trackNativeTreeDeletes(nested.tree, onDelete);
  }
  return count;
}

function decorationClasses(
  state: EditorState,
  analysis = __testLiveMdAnalysis({ state } as EditorView),
) {
  let classes = new Set<string>();
  analysis.decorations.between(0, state.doc.length, (_from, _to, value) => {
    let className = (value.spec as { class?: string }).class;
    for (let name of className?.split(/\s+/) ?? []) {
      if (name) classes.add(name);
    }
  });
  return classes;
}

function markHeadingFeature(className: string) {
  return liveMdMarkdownFeatures([
    {
      name: className,
      query: "(atx_heading) @heading",
      decorate({ addMark, node }) {
        let heading = node("heading");
        if (!heading) return;
        addMark(heading.from, heading.to, className);
      },
    },
  ]);
}

function liveMdKitchenSinkDoc() {
  return (
    "# Heading One\n\n" +
    "Paragraph with _emphasis_, **bold**, ~~strike~~, `code`, [link](https://example.com), <https://example.com>, $x^2$.\n\n" +
    "> Quote line with **bold** and $y$.\n" +
    "> second quote line\n\n" +
    "- item one\n" +
    "- [x] done item\n" +
    "- [ ] todo item\n\n" +
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

function canonicalAnalysis(state: EditorState, analysis = __testBuildLiveMdAnalysis(state)) {
  let decorations: Array<{ from: number; spec: unknown; to: number }> = [];
  analysis.decorations.between(0, state.doc.length, (from, to, value) => {
    decorations.push({ from, spec: canonicalDecorationSpec(value.spec), to });
  });
  decorations.sort(compareCanonicalRange);

  let atomicRanges: Array<{ from: number; to: number; value: string }> = [];
  analysis.atomicRanges.between(0, state.doc.length, (from, to, value) => {
    atomicRanges.push({ from, to, value: value.constructor.name });
  });
  atomicRanges.sort(compareCanonicalRange);

  return { atomicRanges, decorations };
}

function compareCanonicalRange(
  left: { from: number; spec?: unknown; to: number; value?: string },
  right: { from: number; spec?: unknown; to: number; value?: string },
) {
  return (
    left.from - right.from ||
    left.to - right.to ||
    JSON.stringify(left.spec ?? left.value).localeCompare(JSON.stringify(right.spec ?? right.value))
  );
}

function rangesOverlap(left: DocRange, right: DocRange) {
  return left.from < right.to && right.from < left.to;
}

function canonicalDecorationSpec(spec: Record<string, unknown>) {
  let normalized = { ...spec };
  if (typeof normalized.class == "string") {
    normalized.class = normalized.class.split(/\s+/).filter(Boolean).sort().join(" ");
  }
  let widget = spec.widget;
  if (widget && typeof widget == "object") {
    return {
      ...normalized,
      widget: {
        name: widget.constructor.name,
        props: Object.fromEntries(
          Object.getOwnPropertyNames(widget)
            .sort()
            .map((name) => [name, (widget as Record<string, unknown>)[name]]),
        ),
      },
    };
  }
  return normalized;
}
