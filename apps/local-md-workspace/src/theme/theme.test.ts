import { describe, expect, it } from "vite-plus/test";
import {
  coerceTheme,
  defaultTheme,
  nextTheme,
  themeAppearance,
  themeDefinition,
  themeDefinitions,
} from "./theme";

describe("workspace themes", () => {
  it("defines unique named themes", () => {
    expect(themeDefinitions.map((theme) => theme.id)).toEqual([
      "gruvbox-light",
      "gruvbox-dark",
      "github-light",
      "catppuccin-latte",
      "catppuccin-macchiato",
    ]);
    expect(new Set(themeDefinitions.map((theme) => theme.id)).size).toBe(themeDefinitions.length);
  });

  it("separates named theme ids from light and dark appearance", () => {
    expect(defaultTheme).toBe("gruvbox-dark");
    expect(themeAppearance("github-light")).toBe("light");
    expect(themeAppearance("catppuccin-latte")).toBe("light");
    expect(themeAppearance("catppuccin-macchiato")).toBe("dark");
  });

  it("keeps paired theme toggles explicit", () => {
    expect(nextTheme("gruvbox-light")).toBe("gruvbox-dark");
    expect(nextTheme("gruvbox-dark")).toBe("gruvbox-light");
    expect(nextTheme("catppuccin-latte")).toBe("catppuccin-macchiato");
    expect(nextTheme("catppuccin-macchiato")).toBe("catppuccin-latte");
    expect(nextTheme("github-light")).toBe("gruvbox-dark");
  });

  it("coerces legacy stored light and dark values", () => {
    expect(coerceTheme("light")).toBe("gruvbox-light");
    expect(coerceTheme("dark")).toBe("gruvbox-dark");
    expect(coerceTheme("github-light")).toBe("github-light");
    expect(coerceTheme("unknown")).toBeNull();
  });

  it("looks up theme labels from the registry", () => {
    expect(themeDefinition("catppuccin-macchiato")).toMatchObject({
      appearance: "dark",
      label: "Catppuccin Macchiato",
    });
  });
});
