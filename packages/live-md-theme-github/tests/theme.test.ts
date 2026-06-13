import { describe, expect, it } from "vite-plus/test";
import { liveMdThemeColorVariableNames } from "@codemirror-treesitter/live-md-theme";
import { githubLightLiveMdTheme } from "../src/index.js";

describe("GitHub LiveMD themes", () => {
  it("covers every reusable LiveMD color token", () => {
    expect(Object.keys(githubLightLiveMdTheme.variables).sort()).toEqual([
      ...liveMdThemeColorVariableNames,
    ].sort());
  });

  it("uses neutral GitHub Markdown presentation colors", () => {
    expect(githubLightLiveMdTheme.appearance).toBe("light");
    expect(githubLightLiveMdTheme.variables["--live-md-heading-1"]).toBe("#24292f");
    expect(githubLightLiveMdTheme.variables["--live-md-code-bg"]).toBe("#f6f8fa");
    expect(githubLightLiveMdTheme.variables["--live-md-link"]).toBe("#0969da");
  });
});
