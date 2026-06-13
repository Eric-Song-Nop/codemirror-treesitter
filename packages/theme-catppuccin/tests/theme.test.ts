import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { highlightingFor, syntaxHighlighting, tags } from "@codemirror-treesitter/language";
import { describe, expect, it } from "vite-plus/test";
import {
  catppuccinLatte,
  catppuccinLatteColors,
  catppuccinLatteHighlightStyle,
  catppuccinMacchiato,
  catppuccinMacchiatoColors,
  catppuccinMacchiatoHighlightStyle,
} from "../src/index.js";

describe("catppuccin theme", () => {
  it("installs Latte as a light editor theme and Macchiato as a dark editor theme", () => {
    let latte = EditorState.create({ extensions: [catppuccinLatte] });
    let macchiato = EditorState.create({ extensions: [catppuccinMacchiato] });

    expect(latte.facet(EditorView.darkTheme)).toBe(false);
    expect(macchiato.facet(EditorView.darkTheme)).toBe(true);
  });

  it("maps distinct syntax tags to distinct Latte highlight classes", () => {
    let state = EditorState.create({
      extensions: [syntaxHighlighting(catppuccinLatteHighlightStyle)],
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

  it("maps distinct syntax tags to distinct Macchiato highlight classes", () => {
    let state = EditorState.create({
      extensions: [syntaxHighlighting(catppuccinMacchiatoHighlightStyle)],
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

  it("exports Catppuccin Latte and Macchiato palettes", () => {
    expect(catppuccinLatteColors.base).toBe("#eff1f5");
    expect(catppuccinLatteColors.mauve).toBe("#8839ef");
    expect(catppuccinMacchiatoColors.base).toBe("#24273a");
    expect(catppuccinMacchiatoColors.mauve).toBe("#c6a0f6");
    expect(catppuccinLatteColors.text).not.toBe(catppuccinMacchiatoColors.text);
  });
});
