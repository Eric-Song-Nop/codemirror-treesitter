// @vitest-environment happy-dom

import { EditorState, type Extension } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror-treesitter/language";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { __testBuildLiveMdAnalysis, liveMdAnalysis } from "../src/core/decorations.js";
import { loadMarkdownExtension } from "../src/core/languages.js";
import { __testIsLiveMdSearchVisible, liveMdSearch } from "../src/core/search.js";
import { liveMdFeature } from "../src/index.js";

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

describe("LiveMD feature extensions", () => {
  it("lets callers decorate tree-sitter Markdown captures through a feature extension", async () => {
    let state = await markdownState(
      "> [!note]\n> Body\n",
      liveMdFeature({
        id: "callout",
        query: {
          document: `(block_quote) @callout.block`,
        },
        apply(match, _featureState, context) {
          let block = context.capture(match, "callout.block")?.node;
          if (!block) return;
          let kind = context
            .text(block)
            .match(/^>\s*\[!(\w+)\]/)?.[1]
            ?.toLowerCase();
          if (!kind) return;
          context.lineClass(block.from, block.to, `cm-md-callout cm-md-callout-${kind}`);
        },
      }),
    );

    let lineClasses = decorationClasses(state).filter((className) =>
      className.includes("cm-md-callout"),
    );

    expect(lineClasses).toEqual([
      "cm-md-blockquote cm-md-callout cm-md-callout-note",
      "cm-md-blockquote cm-md-callout cm-md-callout-note",
    ]);
  });

  it("lets feature extensions hide their syntax from search", async () => {
    let doc = "before\n\n> hidden quote\n\nafter\n";
    let state = await markdownState(
      doc,
      liveMdFeature({
        id: "hiddenBlockquoteSearch",
        search: {
          hiddenQuery: {
            document: `(block_quote) @hidden.blockquote`,
          },
        },
      }),
      liveMdSearch,
    );
    let hiddenFrom = doc.indexOf("hidden");
    let afterFrom = doc.indexOf("after");

    expect(__testIsLiveMdSearchVisible(state, hiddenFrom, hiddenFrom + "hidden".length)).toBe(
      false,
    );
    expect(__testIsLiveMdSearchVisible(state, afterFrom, afterFrom + "after".length)).toBe(true);
  });
});

async function markdownState(doc: string, ...extensions: Extension[]) {
  let state = EditorState.create({
    doc,
    extensions: [await loadMarkdownExtension(), extensions, liveMdAnalysis],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state;
}

function decorationClasses(state: EditorState) {
  let classes: string[] = [];
  __testBuildLiveMdAnalysis(state).decorations.between(0, state.doc.length, (_from, _to, value) => {
    let className = (value.spec as { class?: string }).class;
    if (className) classes.push(className);
  });
  return classes;
}
