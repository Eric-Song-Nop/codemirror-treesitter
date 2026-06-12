import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { highlightingFor, syntaxHighlighting, tags } from "@codemirror-treesitter/language";
import { createCodeMirrorTheme } from "@codemirror-treesitter/theme";
import { describe, expect, it } from "vite-plus/test";
import {
  gruvboxDark,
  gruvboxDarkColors,
  gruvboxDarkHighlightStyle,
  gruvboxDarkLiveMdExtensions,
  gruvboxDarkSpec,
  gruvboxDarkTheme,
  gruvboxDarkThemeSpec,
  gruvboxLight,
  gruvboxLightColors,
  gruvboxLightHighlightStyle,
  gruvboxLightLiveMdExtensions,
  gruvboxLightSpec,
  gruvboxLightTheme,
  gruvboxLightThemeSpec,
} from "../src/index.js";

describe("gruvbox theme", () => {
  it("installs dark and light editor themes", () => {
    let dark = EditorState.create({ extensions: [gruvboxDark] });
    let light = EditorState.create({ extensions: [gruvboxLight] });

    expect(dark.facet(EditorView.darkTheme)).toBe(true);
    expect(light.facet(EditorView.darkTheme)).toBe(false);

    let darkTheme = EditorState.create({ extensions: [gruvboxDarkTheme] });
    let lightTheme = EditorState.create({ extensions: [gruvboxLightTheme] });

    expect(darkTheme.facet(EditorView.darkTheme)).toBe(true);
    expect(lightTheme.facet(EditorView.darkTheme)).toBe(false);
  });

  it("exposes dark and light highlight styles", () => {
    let dark = EditorState.create({ extensions: [syntaxHighlighting(gruvboxDarkHighlightStyle)] });
    let light = EditorState.create({
      extensions: [syntaxHighlighting(gruvboxLightHighlightStyle)],
    });

    expect(highlightingFor(dark, [tags.keyword])).toBeTruthy();
    expect(highlightingFor(light, [tags.keyword])).toBeTruthy();
  });

  it("exposes semantic specs for shared theme helpers", () => {
    let dark = EditorState.create({ extensions: [createCodeMirrorTheme(gruvboxDarkThemeSpec)] });
    let light = EditorState.create({ extensions: [createCodeMirrorTheme(gruvboxLightThemeSpec)] });

    expect(dark.facet(EditorView.darkTheme)).toBe(true);
    expect(light.facet(EditorView.darkTheme)).toBe(false);
    expect(gruvboxDarkThemeSpec.syntax.keyword).toBe(gruvboxDarkColors.red);
    expect(gruvboxLightThemeSpec.syntax.string).toBe(gruvboxLightColors.green);
    expect(gruvboxDarkSpec).toBe(gruvboxDarkThemeSpec);
    expect(gruvboxLightSpec).toBe(gruvboxLightThemeSpec);
  });

  it("exports LiveMD-ready extension bundles", () => {
    let dark = EditorState.create({ extensions: [gruvboxDarkLiveMdExtensions] });
    let light = EditorState.create({ extensions: [gruvboxLightLiveMdExtensions] });

    expect(dark.facet(EditorView.darkTheme)).toBe(true);
    expect(light.facet(EditorView.darkTheme)).toBe(false);
  });

  it("exports distinct dark and light palettes", () => {
    expect(gruvboxDarkColors.bg0).toBe("#282828");
    expect(gruvboxLightColors.bg0).toBe("#fbf1c7");
    expect(gruvboxDarkColors.fg1).not.toBe(gruvboxLightColors.fg1);
  });
});
