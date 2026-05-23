import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vite-plus/test";
import {
  gruvboxDark,
  gruvboxDarkColors,
  gruvboxDarkHighlightStyle,
  gruvboxLight,
  gruvboxLightColors,
  gruvboxLightHighlightStyle,
} from "../src/index.js";
import { highlightingFor, syntaxHighlighting, tags } from "@codemirror-treesitter/language";

describe("gruvbox theme", () => {
  it("installs dark and light editor themes", () => {
    let dark = EditorState.create({ extensions: [gruvboxDark] });
    let light = EditorState.create({ extensions: [gruvboxLight] });

    expect(dark.facet(EditorView.darkTheme)).toBe(true);
    expect(light.facet(EditorView.darkTheme)).toBe(false);
  });

  it("exposes dark and light highlight styles", () => {
    let dark = EditorState.create({ extensions: [syntaxHighlighting(gruvboxDarkHighlightStyle)] });
    let light = EditorState.create({
      extensions: [syntaxHighlighting(gruvboxLightHighlightStyle)],
    });

    expect(highlightingFor(dark, [tags.keyword])).toBeTruthy();
    expect(highlightingFor(light, [tags.keyword])).toBeTruthy();
  });

  it("exports distinct dark and light palettes", () => {
    expect(gruvboxDarkColors.bg0).toBe("#282828");
    expect(gruvboxLightColors.bg0).toBe("#fbf1c7");
    expect(gruvboxDarkColors.fg1).not.toBe(gruvboxLightColors.fg1);
  });
});
