import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";
import { liveMdMarkdownDocumentCss } from "../src/core/markdown-html.js";
import { liveMdRawCssPlugin } from "../vite-plugin.ts";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const liveMdSourceRoot = join(workspaceRoot, "packages/live-md/src");

describe("public LiveMD stylesheet", () => {
  it("keeps code block spacing inside measured line boxes", async () => {
    let css = await readFile(join(liveMdSourceRoot, "style.css"), "utf8");

    expect(css).not.toMatch(/\.cm-md-code-block-start\s*\{[^}]*margin-top/u);
    expect(css).not.toMatch(/\.cm-md-code-block-end\s*\{[^}]*margin-bottom/u);
    expect(css).toContain("padding-top: calc(8px + 0.45em)");
    expect(css).toContain("padding-bottom: calc(8px + 0.55em)");
  });

  it("exports rich Markdown preview CSS for standalone HTML", () => {
    let css = liveMdMarkdownDocumentCss();

    expect(css).toContain(".katex .katex-mathml");
    expect(css).toContain(".live-md-document .cm-md-latex-display .katex-display");
    expect(css).toContain(".live-md-document .cm-md-mermaid-render");
    expect(css).toContain(".live-md-document .cm-md-table-preview");
    expect(css).toContain("min-width: 520px");
    expect(css).toContain("object-fit: contain");
    expect(css).not.toContain("object-fit: cover");
  });

  it("bundles KaTeX rules and fonts for programmatic editors", async () => {
    let root = await mkdtemp(join(workspaceRoot, ".tmp-live-md-style-"));

    try {
      await writeFile(
        join(root, "index.ts"),
        'import "@codemirror-treesitter/live-md/style.css";\n',
      );

      let result = await build({
        root,
        publicDir: false,
        logLevel: "silent",
        build: {
          assetsInlineLimit: 0,
          cssCodeSplit: false,
          minify: false,
          rollupOptions: {
            input: join(root, "index.ts"),
          },
          write: false,
        },
      });
      let outputs = collectBuildOutputs(result);
      let css = outputs
        .filter((output) => output.type == "asset" && output.fileName.endsWith(".css"))
        .map((output) => String(output.source))
        .join("\n");
      let fontAssets = outputs.filter(
        (output) => output.type == "asset" && /KaTeX_.*\.woff2$/.test(output.fileName),
      );

      expect(css).toContain(".katex .katex-mathml");
      expect(css).toContain('font-family: "KaTeX_Main"');
      expect(css).toContain(".live-md-codemirror .cm-md-latex-inline .katex");
      expect(css).toContain(".live-md-codemirror .cm-md-mermaid");
      expect(css).toContain("Noto Serif");
      expect(css).toContain("font-synthesis: weight style");
      expect(css).toContain(".live-md-codemirror.live-md-codemirror .cm-scroller");
      expect(css).toContain(".live-md-codemirror.live-md-codemirror .cm-content");
      expect(css).toContain(".live-md-codemirror.live-md-codemirror .cm-line");
      expect(css).toContain("--live-md-mermaid-accent");
      expect(css).toContain("--live-md-mermaid-font");
      expect(css).not.toContain('@import "katex/dist/katex.css"');
      expect(fontAssets.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("web component shadow stylesheet", () => {
  it("inlines KaTeX font URLs when LiveMD is consumed through source aliases", async () => {
    let root = await mkdtemp(join(workspaceRoot, ".tmp-live-md-source-style-"));

    try {
      await writeFile(
        join(root, "index.ts"),
        'import "@codemirror-treesitter/live-md/register";\n',
      );

      let result = await build({
        root,
        publicDir: false,
        logLevel: "silent",
        plugins: [liveMdRawCssPlugin()],
        resolve: {
          alias: {
            "@codemirror-treesitter/live-md/register": join(liveMdSourceRoot, "register.ts"),
            "@codemirror-treesitter/live-md": join(liveMdSourceRoot, "index.ts"),
          },
        },
        build: {
          assetsInlineLimit: 0,
          minify: false,
          rollupOptions: {
            input: join(root, "index.ts"),
          },
          write: false,
        },
      });
      let javascript = collectBuildOutputs(result)
        .filter((output) => output.type == "chunk")
        .map((output) => String(output.code))
        .join("\n");

      expect(javascript).toContain(".katex .katex-mathml");
      expect(javascript).toContain("data:font/woff2;base64");
      expect(javascript).toContain(".live-md-codemirror .cm-md-latex-inline .katex");
      expect(javascript).toContain(".live-md-codemirror .cm-md-mermaid");
      expect(javascript).toContain("Noto Serif");
      expect(javascript).toContain("font-synthesis: weight style");
      expect(javascript).toContain(".live-md-codemirror.live-md-codemirror .cm-scroller");
      expect(javascript).toContain(".live-md-codemirror.live-md-codemirror .cm-content");
      expect(javascript).toContain(".live-md-codemirror.live-md-codemirror .cm-line");
      expect(javascript).toContain("--live-md-mermaid-accent");
      expect(javascript).toContain("--live-md-mermaid-font");
      expect(javascript).not.toContain("url(fonts/KaTeX_");
      expect(javascript).not.toContain('@import "katex/dist/katex.css"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

type BuildOutput = {
  code?: unknown;
  fileName: string;
  source?: unknown;
  type: string;
};

type BuildOutputResult = {
  output: BuildOutput[];
};

function collectBuildOutputs(result: Awaited<ReturnType<typeof build>>): BuildOutput[] {
  let buildResults: BuildOutputResult[];
  if (Array.isArray(result)) {
    buildResults = result as BuildOutputResult[];
  } else if ("output" in result) {
    buildResults = [result as BuildOutputResult];
  } else {
    throw new Error("Expected a Vite build output, got a watcher");
  }

  return buildResults.flatMap((entry) => entry.output);
}
