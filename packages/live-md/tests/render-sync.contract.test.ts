// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import {
  Compartment,
  StateEffect,
  StateField,
  __testBuildCanonicalLiveMdAnalysis,
  __testFlushLiveMdAnalysis,
  __testLiveMdAnalysis,
  canonicalAnalysis,
  decorationClasses,
  decorationClassesFromSet,
  emptyLiveMdLeafAnalysisTrace,
  ensureSyntaxTree,
  explicitCodeFenceClasses,
  explicitCodeFenceSurface,
  imagePreviewSources,
  installAnalysisTestEnvironment,
  legacyFeatureFullQueryCount,
  lineHasClass,
  liveMdCodeFenceHighlighting,
  liveMdImageSource,
  liveMdMarkdownFeatures,
  loadCodeFenceLanguages,
  markHeadingFeature,
  markdownAnalysisState,
  markdownAnalysisView,
  normalizeMarkdownImageSource,
  setCodeFenceLanguages,
  syntaxHighlighting,
  t,
  tablePreviewTables,
  testDarkCodeFenceHighlightStyle,
  testLightCodeFenceHighlightStyle,
  trackNativeTreeDeletes,
} from "./helpers/analysis.js";

installAnalysisTestEnvironment();

describe("LiveMD render sync contract", () => {
  it("recomputes active-dependent legacy feature decorations on selection changes", async () => {
    let doc = "# First\n\nparagraph with *one*\n\n# Second\n";
    let view = await markdownAnalysisView(doc, "First", [
      liveMdMarkdownFeatures([
        {
          name: "test-active-heading-feature",
          query: "(atx_heading) @target",
          decorate({ addLineClass, node, rangeTouchesActiveLine }) {
            let target = node("target");
            if (target && rangeTouchesActiveLine(target.from, target.to)) {
              addLineClass(target.from, target.to, "is-active");
            }
          },
        },
      ]),
    ]);

    expect(lineHasClass(view.state, "# First", "is-active")).toBe(true);
    expect(lineHasClass(view.state, "# Second", "is-active")).toBe(false);

    view.dispatch({ selection: { anchor: doc.indexOf("Second") } });

    expect(lineHasClass(view.state, "# First", "is-active")).toBe(false);
    expect(lineHasClass(view.state, "# Second", "is-active")).toBe(true);
    expect(__testLiveMdAnalysis(view).semanticTrace?.legacyFeatureFullQueryCount).toBe(1);
    expect(canonicalAnalysis(view.state, __testLiveMdAnalysis(view))).toEqual(
      canonicalAnalysis(view.state, __testBuildCanonicalLiveMdAnalysis(view.state)),
    );
    view.destroy();
  });

  it("recomputes legacy feature decorations for arbitrary StateField changes", async () => {
    let setClass = StateEffect.define<string>();
    let classField = StateField.define<string>({
      create() {
        return "cm-md-feature-first";
      },
      update(value, transaction) {
        for (let effect of transaction.effects) {
          if (effect.is(setClass)) return effect.value;
        }
        return value;
      },
    });
    let view = await markdownAnalysisView("# Dynamic\n\nbody", "body", [
      classField,
      liveMdMarkdownFeatures([
        {
          name: "test-state-field-feature",
          query: "(atx_heading) @heading",
          decorate({ addMark, node, state }) {
            let heading = node("heading");
            if (!heading) return;
            addMark(heading.from, heading.to, state.field(classField));
          },
        },
      ]),
    ]);

    expect(decorationClasses(view.state).has("cm-md-feature-first")).toBe(true);
    expect(decorationClasses(view.state).has("cm-md-feature-second")).toBe(false);

    view.dispatch({ effects: setClass.of("cm-md-feature-second") });

    expect(decorationClasses(view.state).has("cm-md-feature-first")).toBe(false);
    expect(decorationClasses(view.state).has("cm-md-feature-second")).toBe(true);
    expect(__testLiveMdAnalysis(view).semanticTrace?.legacyFeatureFullQueryCount).toBe(1);
    view.destroy();
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

  it("parses code fence highlights for the runtime surface and explicit compiler oracles", async () => {
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

    let view = await markdownAnalysisView(doc, "", [
      syntaxHighlighting(testLightCodeFenceHighlightStyle),
    ]);
    view.dispatch({ effects: setCodeFenceLanguages.of(languages) });
    let keywordClass = testLightCodeFenceHighlightStyle.style([t.keyword]);
    if (!keywordClass) throw new Error("Expected keyword highlight class");
    let initialAnalysis = __testLiveMdAnalysis(view);
    expect(parseCalls).toBe(1);
    expect(parserCreate).toBe(1);
    expect(nestedOwnerMaps).toBe(1);
    expect(nestedParserCreate).toBeGreaterThan(0);
    expect(parserDelete).toBe(1);
    expect(nestedParserDelete).toBe(nestedParserCreate);
    expect(treeCreate).toBeGreaterThan(1);
    expect(treeDelete).toBe(treeCreate);
    expect(
      decorationClassesFromSet(view.state, initialAnalysis.surfaceDecorations).has(keywordClass),
    ).toBe(true);
    expect(initialAnalysis.trace.codeFenceParserSessionsCreated).toBe(
      parserCreate + nestedParserCreate,
    );
    expect(initialAnalysis.trace.codeFenceParserSessionsDeleted).toBe(
      parserDelete + nestedParserDelete,
    );
    expect(initialAnalysis.trace.codeFenceParses).toBe(1);
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
    let initialTrace = emptyLiveMdLeafAnalysisTrace();
    let initialSurface = explicitCodeFenceSurface(
      view.state,
      [testLightCodeFenceHighlightStyle],
      initialTrace,
      initialAnalysis,
    );
    expect(parseCalls).toBe(1);
    expect(parserCreate).toBe(1);
    expect(nestedOwnerMaps).toBe(1);
    expect(nestedParserCreate).toBeGreaterThan(0);
    expect(parserDelete).toBe(1);
    expect(nestedParserDelete).toBe(nestedParserCreate);
    expect(treeCreate).toBeGreaterThan(1);
    expect(treeDelete).toBe(treeCreate);
    expect(decorationClassesFromSet(view.state, initialSurface.decorations).has(keywordClass)).toBe(
      true,
    );
    expect(initialTrace.codeFenceParserSessionsCreated).toBe(parserCreate + nestedParserCreate);
    expect(initialTrace.codeFenceParserSessionsDeleted).toBe(parserDelete + nestedParserDelete);
    expect(initialTrace.codeFenceParses).toBe(1);
    expect(initialTrace.codeFenceTreesCreated).toBe(treeCreate);
    expect(initialTrace.codeFenceTreesDeleted).toBe(treeDelete);

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
    await __testFlushLiveMdAnalysis(view);

    let editedAnalysis = __testLiveMdAnalysis(view);
    expect(parseCalls).toBe(1);
    expect(parserCreate).toBe(1);
    expect(nestedOwnerMaps).toBe(1);
    expect(nestedParserCreate).toBeGreaterThan(0);
    expect(parserDelete).toBe(1);
    expect(nestedParserDelete).toBe(nestedParserCreate);
    expect(treeCreate).toBeGreaterThan(1);
    expect(treeDelete).toBe(treeCreate);
    expect(
      decorationClassesFromSet(view.state, editedAnalysis.surfaceDecorations).has(keywordClass),
    ).toBe(true);
    expect(editedAnalysis.trace.codeFenceParserSessionsCreated).toBe(
      parserCreate + nestedParserCreate,
    );
    expect(editedAnalysis.trace.codeFenceParserSessionsDeleted).toBe(
      parserDelete + nestedParserDelete,
    );
    expect(editedAnalysis.trace.codeFenceParses).toBe(1);
    expect(editedAnalysis.trace.codeFenceTreesCreated).toBe(treeCreate);
    expect(editedAnalysis.trace.codeFenceTreesDeleted).toBe(treeDelete);

    parseCalls = 0;
    parserCreate = 0;
    parserDelete = 0;
    nestedOwnerMaps = 0;
    nestedParserCreate = 0;
    nestedParserDelete = 0;
    treeCreate = 0;
    treeDelete = 0;
    let editedTrace = emptyLiveMdLeafAnalysisTrace();
    let editedSurface = explicitCodeFenceSurface(
      view.state,
      [testLightCodeFenceHighlightStyle],
      editedTrace,
      editedAnalysis,
    );
    expect(parseCalls).toBe(1);
    expect(parserCreate).toBe(1);
    expect(nestedOwnerMaps).toBe(1);
    expect(nestedParserCreate).toBeGreaterThan(0);
    expect(parserDelete).toBe(1);
    expect(nestedParserDelete).toBe(nestedParserCreate);
    expect(treeCreate).toBeGreaterThan(1);
    expect(treeDelete).toBe(treeCreate);
    expect(decorationClassesFromSet(view.state, editedSurface.decorations).has(keywordClass)).toBe(
      true,
    );
    expect(editedTrace.codeFenceParserSessionsCreated).toBe(parserCreate + nestedParserCreate);
    expect(editedTrace.codeFenceParserSessionsDeleted).toBe(parserDelete + nestedParserDelete);
    expect(editedTrace.codeFenceParses).toBe(1);
    expect(editedTrace.codeFenceTreesCreated).toBe(treeCreate);
    expect(editedTrace.codeFenceTreesDeleted).toBe(treeDelete);
    view.destroy();
  });

  it("updates runtime code fence classes when the highlighter is reconfigured", async () => {
    let highlighterCompartment = new Compartment();
    let view = await markdownAnalysisView("```ts\nlet answer = 1;\n```\n", "", [
      highlighterCompartment.of(syntaxHighlighting(testLightCodeFenceHighlightStyle)),
    ]);
    view.dispatch({ effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()) });
    let lightKeywordClass = testLightCodeFenceHighlightStyle.style([t.keyword]);
    let darkKeywordClass = testDarkCodeFenceHighlightStyle.style([t.keyword]);

    expect(lightKeywordClass).toBeTruthy();
    expect(darkKeywordClass).toBeTruthy();
    let initial = __testLiveMdAnalysis(view);
    let initialClasses = decorationClassesFromSet(view.state, initial.surfaceDecorations);
    expect(initialClasses.has(lightKeywordClass!)).toBe(true);
    expect(initialClasses.has(darkKeywordClass!)).toBe(false);
    expect(initial.trace.codeFenceParses).toBe(1);
    expect(
      explicitCodeFenceClasses(view.state, [testLightCodeFenceHighlightStyle]).has(
        lightKeywordClass!,
      ),
    ).toBe(true);

    view.dispatch({
      effects: highlighterCompartment.reconfigure(
        syntaxHighlighting(testDarkCodeFenceHighlightStyle),
      ),
    });

    let after = __testLiveMdAnalysis(view);
    let afterClasses = decorationClassesFromSet(view.state, after.surfaceDecorations);
    expect(after.trace.codeFenceParses).toBe(1);
    expect(afterClasses.has(darkKeywordClass!)).toBe(true);
    expect(afterClasses.has(lightKeywordClass!)).toBe(false);
    expect(
      explicitCodeFenceClasses(view.state, [testDarkCodeFenceHighlightStyle]).has(
        darkKeywordClass!,
      ),
    ).toBe(true);
    view.destroy();
  });

  it("uses explicit code fence highlighter overrides in the runtime surface", async () => {
    let view = await markdownAnalysisView("```ts\nlet answer = 1;\n```\n", "", [
      syntaxHighlighting(testLightCodeFenceHighlightStyle),
      liveMdCodeFenceHighlighting(testDarkCodeFenceHighlightStyle),
    ]);
    view.dispatch({ effects: setCodeFenceLanguages.of(await loadCodeFenceLanguages()) });
    let lightKeywordClass = testLightCodeFenceHighlightStyle.style([t.keyword]);
    let darkKeywordClass = testDarkCodeFenceHighlightStyle.style([t.keyword]);

    expect(darkKeywordClass).toBeTruthy();
    let analysis = __testLiveMdAnalysis(view);
    let classes = decorationClassesFromSet(view.state, analysis.surfaceDecorations);
    expect(classes.has(darkKeywordClass!)).toBe(true);
    expect(classes.has(lightKeywordClass!)).toBe(false);
    expect(analysis.trace.codeFenceParses).toBe(1);
    expect(
      explicitCodeFenceClasses(view.state, [testDarkCodeFenceHighlightStyle]).has(
        darkKeywordClass!,
      ),
    ).toBe(true);
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

  it("counts legacy feature full-query projection after document changes", async () => {
    let decoratedHeadings: string[] = [];
    let doc = "# First\n\nbody\n\n# Second\n";
    let view = await markdownAnalysisView(doc, "body", [
      liveMdMarkdownFeatures([
        {
          name: "test-heading-feature",
          query: "(atx_heading) @heading",
          decorate({ addMark, node, slice }) {
            let heading = node("heading");
            if (!heading) return;
            decoratedHeadings.push(slice(heading).trimEnd());
            addMark(heading.from, heading.to, "cm-md-feature-heading");
          },
        },
      ]),
    ]);

    decoratedHeadings = [];
    let replaceFrom = doc.indexOf("# Second");
    let transaction = view.state.update({
      changes: {
        from: replaceFrom,
        insert: "# Updated\n\n# Third\n",
        to: doc.length,
      },
    });
    ensureSyntaxTree(transaction.state, transaction.state.doc.length, 5_000);
    view.dispatch(transaction);
    await __testFlushLiveMdAnalysis(view);

    let after = __testLiveMdAnalysis(view);
    expect(legacyFeatureFullQueryCount(after)).toBe(1);
    expect(decoratedHeadings).toEqual(["# First", "# Updated", "# Third"]);
    expect(decorationClasses(view.state).has("cm-md-feature-heading")).toBe(true);
    view.destroy();
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
