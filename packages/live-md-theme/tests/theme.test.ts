import { describe, expect, it } from "vite-plus/test";
import {
  clearLiveMdThemeVariables,
  createLiveMdTheme,
  liveMdThemeColorVariableNames,
  setLiveMdThemeVariables,
  type LiveMdThemeVariableTarget,
} from "../src/index.js";

describe("LiveMD theme contract", () => {
  it("keeps color variables separate from product layout variables", () => {
    expect(liveMdThemeColorVariableNames).toContain("--live-md-bg");
    expect(liveMdThemeColorVariableNames).toContain("--live-md-code-bg");
    expect(liveMdThemeColorVariableNames).not.toContain("--live-md-content-width");
    expect(liveMdThemeColorVariableNames).not.toContain("--live-md-font-body");
  });

  it("applies and clears theme variables on a host target", () => {
    let properties = new Map<string, string>();
    let target: LiveMdThemeVariableTarget = {
      style: {
        removeProperty(name) {
          let value = properties.get(name) ?? "";
          properties.delete(name);
          return value;
        },
        setProperty(name, value) {
          properties.set(name, value);
        },
      },
    };
    let theme = createLiveMdTheme({
      appearance: "dark",
      id: "test-dark",
      variables: {
        "--live-md-bg": "#111111",
        "--live-md-code-bg": "#222222",
      },
    });

    setLiveMdThemeVariables(target, theme);
    expect(properties.get("--live-md-bg")).toBe("#111111");
    expect(properties.get("--live-md-code-bg")).toBe("#222222");

    clearLiveMdThemeVariables(target);
    expect(properties.size).toBe(0);
  });
});
