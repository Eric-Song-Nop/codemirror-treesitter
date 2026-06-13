import { describe, expect, it } from "vite-plus/test";
import {
  catppuccinLatteColors,
  catppuccinMacchiatoColors,
  githubLightColors,
  gruvboxDarkColors,
  gruvboxLightColors,
} from "../src/index.js";

describe("theme palettes", () => {
  it("exports reusable palette objects for all concrete themes", () => {
    expect(gruvboxDarkColors.bg0).toBe("#282828");
    expect(gruvboxLightColors.bg0).toBe("#fbf1c7");
    expect(githubLightColors.foreground).toBe("#24292f");
    expect(catppuccinLatteColors.base).toBe("#eff1f5");
    expect(catppuccinMacchiatoColors.base).toBe("#24273a");
  });
});
