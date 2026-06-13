import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { highlightingFor, syntaxHighlighting, tags } from "@codemirror-treesitter/language";
import { describe, expect, it } from "vite-plus/test";
import {
  createCodeMirrorTheme,
  createHighlightStyle,
  type SemanticThemeSpec,
} from "../src/index.js";

const testTheme: SemanticThemeSpec = {
  appearance: "light",
  chrome: {
    activeLine: "#f6f8fa",
    background: "#ffffff",
    border: "#d0d7de",
    cursor: "#0969da",
    foldPlaceholderBorder: "#d0d7de",
    foldPlaceholderText: "#6e7781",
    foreground: "#24292f",
    gutterActiveBackground: "#f6f8fa",
    gutterActiveForeground: "#57606a",
    gutterBackground: "#ffffff",
    gutterBorder: "#d0d7de",
    gutterForeground: "#6e7781",
    matchingBracketBackground: "#0969da26",
    matchingBracketBorder: "#0969da",
    nonmatchingBracketBackground: "#cf222e26",
    nonmatchingBracketBorder: "#cf222e",
    panelBackground: "#f6f8fa",
    panelBorder: "#d0d7de",
    panelForeground: "#24292f",
    searchMatch: "#fff8c5",
    searchMatchBorder: "#9a6700",
    searchMatchSelected: "#ffd33d66",
    selection: "#d0d7de",
    selectionMatch: "#0969da1f",
    tooltipBackground: "#f6f8fa",
    tooltipBorder: "#d0d7de",
    tooltipForeground: "#24292f",
    tooltipSelectedBackground: "#d0d7de",
    tooltipSelectedForeground: "#24292f",
  },
  syntax: {
    atom: "#8250df",
    bool: "#0550ae",
    character: "#116329",
    className: "#953800",
    comment: "#6e7781",
    constant: "#0550ae",
    definition: "#24292f",
    deleted: "#cf222e",
    escape: "#116329",
    functionName: "#8250df",
    heading: "#24292f",
    inserted: "#116329",
    invalid: "#cf222e",
    keyword: "#cf222e",
    labelName: "#8250df",
    link: "#0969da",
    macroName: "#8250df",
    meta: "#6e7781",
    modifier: "#cf222e",
    namespace: "#24292f",
    number: "#0550ae",
    operator: "#24292f",
    propertyName: "#953800",
    regexp: "#116329",
    separator: "#24292f",
    specialString: "#116329",
    specialVariable: "#0550ae",
    standardName: "#24292f",
    string: "#0a3069",
    typeName: "#953800",
    url: "#0969da",
    variableName: "#24292f",
  },
};

describe("semantic CodeMirror theme helpers", () => {
  it("creates editor extensions with the requested appearance", () => {
    let state = EditorState.create({ extensions: [createCodeMirrorTheme(testTheme)] });

    expect(state.facet(EditorView.darkTheme)).toBe(false);
  });

  it("maps syntax tags through semantic highlight classes", () => {
    let state = EditorState.create({
      extensions: [syntaxHighlighting(createHighlightStyle(testTheme.syntax))],
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
});
