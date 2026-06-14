import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { highlightingFor, syntaxHighlighting, tags } from "@codemirror-treesitter/language";
import { describe, expect, it } from "vite-plus/test";
import {
  githubLight,
  githubLightColors,
  githubLightHighlightStyle,
  githubLightThemeSpec,
} from "../src/index.js";

describe("GitHub Light theme", () => {
  it("installs a light editor theme", () => {
    let state = EditorState.create({ extensions: [githubLight] });

    expect(state.facet(EditorView.darkTheme)).toBe(false);
  });

  it("maps distinct syntax tags to distinct highlight classes", () => {
    let state = EditorState.create({
      extensions: [syntaxHighlighting(githubLightHighlightStyle)],
    });

    let keyword = highlightingFor(state, [tags.keyword]);
    let string = highlightingFor(state, [tags.string]);
    let functionName = highlightingFor(state, [tags.function(tags.variableName)]);
    let number = highlightingFor(state, [tags.number]);

    expect(keyword).toBeTruthy();
    expect(string).toBeTruthy();
    expect(functionName).toBeTruthy();
    expect(number).toBeTruthy();
    expect(new Set([keyword, string, functionName, number]).size).toBe(4);
  });

  it("exposes GitHub Light semantic colors", () => {
    expect(githubLightColors.foreground).toBe("#24292f");
    expect(githubLightColors.background).toBe("#ffffff");
    expect(githubLightColors.subtleBackground).toBe("#f6f8fa");
    expect(githubLightThemeSpec.syntax.keyword).toBe("#cf222e");
    expect(githubLightThemeSpec.syntax.string).toBe("#0a3069");
  });
});
