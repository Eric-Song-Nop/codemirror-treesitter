import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { themeDefinitions } from "./theme";

const workspaceCss = readText("../index.css");
const liveMdEditorSource = readText("../components/LiveMdEditor.tsx");
const liveMdStyle = readText("../../../../packages/live-md/src/style.css");

describe("workspace theme contract", () => {
  it("keeps every named theme wired through CSS tokens and the LiveMD adapter", () => {
    let themeIds = themeDefinitions.map((theme) => theme.id).sort();
    let cssThemeIds = cssThemeBlockIds(workspaceCss).sort();
    let liveMdAdapterThemeIds = Array.from(
      new Set(
        Array.from(
          liveMdThemeExtensionMapBlock(liveMdEditorSource).matchAll(/"([^"]+)":/g),
          (match) => match[1]!,
        ),
      ),
    ).sort();

    expect(cssThemeIds).toEqual(themeIds);
    expect(liveMdAdapterThemeIds).toEqual(themeIds);
  });

  it("maps the full public LiveMD token contract into the local workspace", () => {
    let publicLiveMdTokens = cssDeclarationNames(hostBlock(liveMdStyle), "--live-md-");
    let mappedLiveMdTokens = cssDeclarationNames(
      cssBlock(workspaceCss, ".local-md-live-editor"),
      "--live-md-",
    );

    expect(mappedLiveMdTokens).toEqual(publicLiveMdTokens);
  });

  it("defines the same LiveMD presentation tokens for every named theme", () => {
    let themeSpecificTokens = Array.from(
      cssBlock(workspaceCss, ".local-md-live-editor").matchAll(/var\((--theme-live-md-[^)]+)\)/g),
      (match) => match[1]!,
    ).sort();

    for (let theme of themeDefinitions) {
      expect(cssDeclarationNames(themeBlock(workspaceCss, theme.id), "--theme-live-md-")).toEqual(
        themeSpecificTokens,
      );
    }
  });

  it("keeps GitHub Light rendered Markdown neutral instead of inheriting Gruvbox headings", () => {
    let githubLight = themeBlock(workspaceCss, "github-light");

    expect(cssDeclarationValue(githubLight, "--theme-live-md-heading-1")).toBe("#24292f");
    expect(cssDeclarationValue(githubLight, "--theme-live-md-heading-2")).toBe("#24292f");
    expect(cssDeclarationValue(githubLight, "--theme-live-md-heading-3")).toBe("#24292f");
    expect(cssDeclarationValue(githubLight, "--theme-live-md-heading-rest")).toBe("#24292f");
    expect(cssDeclarationValue(githubLight, "--theme-live-md-link")).toBe("#0969da");
    expect(cssDeclarationValue(githubLight, "--theme-live-md-code-bg")).toBe("#f6f8fa");
  });
});

function readText(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function cssThemeBlockIds(css: string) {
  let ids = new Set<string>();
  if (/:root,\s*:root\[data-theme="gruvbox-light"\]\s*\{/.test(css)) ids.add("gruvbox-light");
  for (let match of css.matchAll(/:root\[data-theme="([^"]+)"\]\s*\{/g)) {
    ids.add(match[1]!);
  }
  return Array.from(ids);
}

function themeBlock(css: string, theme: string) {
  if (theme == "gruvbox-light") {
    return regexMatch(css, /:root,\s*:root\[data-theme="gruvbox-light"\]\s*\{([\s\S]*?)\n\}/);
  }
  return cssBlock(css, `:root[data-theme="${theme}"]`);
}

function hostBlock(css: string) {
  return cssBlock(css, ":host");
}

function liveMdThemeExtensionMapBlock(source: string) {
  return regexMatch(
    source,
    /const liveMdThemeExtensionMap = \{([\s\S]*?)\n\} satisfies Record<Theme, Extension>/,
  );
}

function cssBlock(css: string, selector: string) {
  return regexMatch(css, new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\n\\}`));
}

function regexMatch(value: string, pattern: RegExp) {
  let match = pattern.exec(value);
  expect(match, `Expected CSS block matching ${pattern}`).toBeTruthy();
  return match?.[1] ?? "";
}

function cssDeclarationNames(block: string, prefix: string) {
  return Array.from(
    new Set(block.match(new RegExp(`${escapeRegExp(prefix)}[a-z0-9-]+(?=\\s*:)`, "g")) ?? []),
  ).sort();
}

function cssDeclarationValue(block: string, property: string) {
  let match = new RegExp(`${escapeRegExp(property)}\\s*:\\s*([^;]+);`).exec(block);
  expect(match, `Expected ${property} declaration`).toBeTruthy();
  return match?.[1].trim() ?? "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
