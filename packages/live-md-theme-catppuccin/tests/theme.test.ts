import { describe, expect, it } from "vite-plus/test";
import { liveMdThemeColorVariableNames } from "@codemirror-treesitter/live-md-theme";
import {
  catppuccinLatteLiveMdTheme,
  catppuccinMacchiatoLiveMdTheme,
} from "../src/index.js";

describe("Catppuccin LiveMD themes", () => {
  it("covers every reusable LiveMD color token", () => {
    expect(Object.keys(catppuccinLatteLiveMdTheme.variables).sort()).toEqual([
      ...liveMdThemeColorVariableNames,
    ].sort());
    expect(Object.keys(catppuccinMacchiatoLiveMdTheme.variables).sort()).toEqual([
      ...liveMdThemeColorVariableNames,
    ].sort());
  });

  it("keeps Latte and Macchiato presentation colors distinct", () => {
    expect(catppuccinLatteLiveMdTheme.appearance).toBe("light");
    expect(catppuccinMacchiatoLiveMdTheme.appearance).toBe("dark");
    expect(catppuccinLatteLiveMdTheme.variables["--live-md-bg"]).toBe("#eff1f5");
    expect(catppuccinMacchiatoLiveMdTheme.variables["--live-md-bg"]).toBe("#24273a");
  });
});
