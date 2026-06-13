import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { liveMdThemeColorVariableNames } from "@codemirror-treesitter/live-md-theme";
import { githubLightLiveMdTheme } from "@codemirror-treesitter/live-md-theme-github";
import { themeDefinitions } from "./theme";

const workspaceCss = readText("../index.css");
const liveMdEditorSource = readText("../components/LiveMdEditor.tsx");

describe("workspace theme contract", () => {
  it("keeps every named theme wired through CSS tokens and the LiveMD adapter", () => {
    let themeIds = themeDefinitions.map((theme) => theme.id).sort();
    let cssThemeIds = cssThemeBlockIds(workspaceCss).sort();
    let liveMdAdapterThemeIds = Array.from(
      new Set(
        Array.from(
          liveMdThemeDefinitionMapBlock(liveMdEditorSource).matchAll(/"([^"]+)":/g),
          (match) => match[1]!,
        ),
      ),
    ).sort();

    expect(cssThemeIds).toEqual(themeIds);
    expect(liveMdAdapterThemeIds).toEqual(themeIds);
  });

  it("keeps LiveMD presentation colors in theme packages instead of app CSS", () => {
    let localLiveMdBlock = cssBlock(workspaceCss, ".local-md-live-editor");

    expect(localLiveMdBlock).not.toContain("--theme-live-md-");
    expect(liveMdEditorSource).toContain("@codemirror-treesitter/live-md-theme-github");
    expect(liveMdEditorSource).toContain("@codemirror-treesitter/live-md-theme-gruvbox");
    expect(liveMdEditorSource).toContain("@codemirror-treesitter/live-md-theme-catppuccin");
    expect(liveMdEditorSource).not.toContain("LiveMdExtensions");
  });

  it("keeps only product layout and typography LiveMD tokens in local CSS", () => {
    let localLiveMdTokens = cssDeclarationNames(
      cssBlock(workspaceCss, ".local-md-live-editor"),
      "--live-md-",
    );

    expect(localLiveMdTokens).toEqual([
      "--live-md-content-padding-block-end",
      "--live-md-content-padding-block-start",
      "--live-md-content-padding-inline",
      "--live-md-content-width",
      "--live-md-font-body",
      "--live-md-font-code",
      "--live-md-font-ui",
      "--live-md-mermaid-font",
      "--live-md-mermaid-mono-font",
    ]);
  });

  it("requires reusable LiveMD themes to cover every color presentation token", () => {
    expect(Object.keys(githubLightLiveMdTheme.variables).sort()).toEqual([
      ...liveMdThemeColorVariableNames,
    ].sort());
  });

  it("keeps GitHub Light rendered Markdown neutral instead of inheriting Gruvbox headings", () => {
    expect(githubLightLiveMdTheme.variables["--live-md-heading-1"]).toBe("#24292f");
    expect(githubLightLiveMdTheme.variables["--live-md-heading-2"]).toBe("#24292f");
    expect(githubLightLiveMdTheme.variables["--live-md-heading-3"]).toBe("#24292f");
    expect(githubLightLiveMdTheme.variables["--live-md-heading-rest"]).toBe("#24292f");
    expect(githubLightLiveMdTheme.variables["--live-md-link"]).toBe("#0969da");
    expect(githubLightLiveMdTheme.variables["--live-md-code-bg"]).toBe("#f6f8fa");
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

function liveMdThemeDefinitionMapBlock(source: string) {
  return regexMatch(
    source,
    /const liveMdThemeDefinitionMap = \{([\s\S]*?)\n\} satisfies Record<Theme, LiveMdThemeDefinition>/,
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
