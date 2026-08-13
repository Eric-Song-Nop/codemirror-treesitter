import { describe, expect, it } from "vite-plus/test";
import { liveMdThemeColorVariableNames } from "@codemirror-treesitter/live-md-theme";
import { gruvboxDarkLiveMdTheme, gruvboxLightLiveMdTheme } from "../src/index.js";

describe("Gruvbox LiveMD themes", () => {
  it("cover every reusable LiveMD color token", () => {
    expect(Object.keys(gruvboxDarkLiveMdTheme.variables).sort()).toEqual(
      [...liveMdThemeColorVariableNames].sort(),
    );
    expect(Object.keys(gruvboxLightLiveMdTheme.variables).sort()).toEqual(
      [...liveMdThemeColorVariableNames].sort(),
    );
  });

  it("keeps light and dark themes distinct", () => {
    expect(gruvboxDarkLiveMdTheme.appearance).toBe("dark");
    expect(gruvboxLightLiveMdTheme.appearance).toBe("light");
    expect(gruvboxDarkLiveMdTheme.variables["--live-md-bg"]).toBe("#282828");
    expect(gruvboxLightLiveMdTheme.variables["--live-md-bg"]).toBe("#fbf1c7");
  });

  it("uses translucent selection overlays above preview content", () => {
    expect(gruvboxDarkLiveMdTheme.variables["--live-md-selection"]).toBe(
      "color-mix(in srgb, #b8bb26 20%, transparent)",
    );
    expect(gruvboxLightLiveMdTheme.variables["--live-md-selection"]).toBe(
      "color-mix(in srgb, #79740e 20%, transparent)",
    );
  });
});
