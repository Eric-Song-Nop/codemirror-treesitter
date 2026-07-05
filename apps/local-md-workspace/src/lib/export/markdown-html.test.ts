import { describe, expect, it, vi } from "vite-plus/test";
import { liveMdMarkdownFeature } from "@codemirror-treesitter/live-md";
import {
  createStandaloneMarkdownHtml,
  snapshotMarkdownHtmlExportTheme,
  type MarkdownHtmlExportAsset,
} from "./markdown-html.ts";

describe("Markdown HTML export", () => {
  it("renders a standalone GFM document", async () => {
    let result = await createStandaloneMarkdownHtml({
      documentPath: "notes/today.md",
      markdown: [
        "# Today",
        "",
        "- [x] Ship export",
        "- [ ] Add PDF later",
        "",
        "| Format | Status |",
        "| --- | --- |",
        "| HTML | Ready |",
      ].join("\n"),
      title: "Today <draft>",
    });

    expect(result.warnings).toEqual([]);
    expect(result.html).toContain("<!doctype html>");
    expect(result.html).toContain("<title>Today &lt;draft&gt;</title>");
    expect(result.html).toContain('<main class="live-md-document" data-live-md-document>');
    expect(result.html).toContain(".live-md-document h1");
    expect(result.html).toContain(".live-md-document .live-md-task-item.is-checked");
    expect(result.html).not.toContain("markdown-document");
    expect(result.html).toContain("<h1>Today</h1>");
    expect(result.html).toContain('<li class="live-md-task-item is-checked">');
    expect(result.html).toContain('checked="" disabled="" type="checkbox"');
    expect(result.html).toContain("<table>");
    expect(result.html).toContain("<td>Ready</td>");
  });

  it("embeds workspace images as data URLs", async () => {
    let resolveAsset = vi.fn<(path: string, source: string) => MarkdownHtmlExportAsset | null>(
      () => new File([new Uint8Array([1, 2, 3])], "chart.png", { type: "image/png" }),
    );

    let result = await createStandaloneMarkdownHtml({
      documentPath: "notes/daily/today.md",
      markdown: "![Chart](assets/chart.png?raw=true)",
      resolveAsset,
    });

    expect(resolveAsset).toHaveBeenCalledWith(
      "notes/daily/assets/chart.png",
      "assets/chart.png?raw=true",
    );
    expect(result.html).toContain('<img src="data:image/png;base64,AQID" alt="Chart">');
    expect(result.warnings).toEqual([]);
  });

  it("leaves external images alone", async () => {
    let resolveAsset = vi.fn();
    let result = await createStandaloneMarkdownHtml({
      documentPath: "notes/today.md",
      markdown: "![Remote](https://example.com/image.png)",
      resolveAsset,
    });

    expect(resolveAsset).not.toHaveBeenCalled();
    expect(result.html).toContain('<img src="https://example.com/image.png" alt="Remote">');
  });

  it("escapes raw HTML from the Markdown source", async () => {
    let result = await createStandaloneMarkdownHtml({
      documentPath: "note.md",
      markdown: '<script>alert("x")</script>\n\n<span>inline</span>',
    });

    expect(result.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(result.html).toContain("&lt;span&gt;inline&lt;/span&gt;");
    expect(result.html).not.toContain("<script>");
  });

  it("uses the shared markdown feature config during export", async () => {
    let result = await createStandaloneMarkdownHtml({
      documentPath: "notes/today.md",
      markdown: ":::note Export **feature**",
      markdownConfig: {
        features: [
          liveMdMarkdownFeature({
            name: "export-note",
            query: "(paragraph) @html",
            async renderHtml({ renderInline, slice, target }) {
              let source = slice(target).trim();
              if (!source.startsWith(":::note")) return null;
              return `<aside>${await renderInline(source.slice(":::note".length).trim())}</aside>`;
            },
          }),
        ],
      },
    });

    expect(result.html).toContain("<aside>Export <strong>feature</strong></aside>");
  });

  it("reports image warnings without failing the export", async () => {
    let result = await createStandaloneMarkdownHtml({
      documentPath: "notes/today.md",
      markdown: "![Missing](assets/missing.png)",
      resolveAsset: () => null,
    });

    expect(result.html).toContain('<img src="assets/missing.png" alt="Missing">');
    expect(result.warnings).toEqual([
      {
        kind: "image-missing",
        message: "Could not embed image assets/missing.png.",
        path: "notes/assets/missing.png",
        source: "assets/missing.png",
      },
    ]);
  });

  it("inlines scoped LiveMD theme variables when provided", async () => {
    let result = await createStandaloneMarkdownHtml({
      documentPath: "notes/today.md",
      markdown: "# Today",
      theme: {
        colorScheme: "dark",
        pageBackground: "#282828",
        variables: {
          "--live-md-bg": "#282828",
          "--live-md-font-body": '"Geist Variable", ui-sans-serif',
          "--live-md-text": "#ebdbb2",
        },
      },
    });

    expect(result.html).toContain("color-scheme: dark;");
    expect(result.html).toContain("background: #282828;");
    expect(result.html).toContain(".live-md-document {\n  --live-md-bg: #282828;");
    expect(result.html).toContain('  --live-md-font-body: "Geist Variable", ui-sans-serif;');
    expect(result.html).toContain("  --live-md-text: #ebdbb2;");
  });

  it("includes LiveMD rich preview export CSS and theme variables", async () => {
    let result = await createStandaloneMarkdownHtml({
      documentPath: "notes/today.md",
      markdown: "$x^2$",
      theme: {
        variables: {
          "--live-md-mermaid-accent": "#38bdf8",
          "--live-md-table-bg": "#111827",
        },
      },
    });

    expect(result.html).toContain(".katex .katex-mathml");
    expect(result.html).toContain(".live-md-document .cm-md-latex-inline .katex");
    expect(result.html).toContain(".live-md-document .cm-md-mermaid");
    expect(result.html).toContain(".live-md-document .cm-md-table-preview");
    expect(result.html).toContain("  --live-md-mermaid-accent: #38bdf8;");
    expect(result.html).toContain("  --live-md-table-bg: #111827;");
    expect(result.html).toContain('<span class="cm-md-latex cm-md-latex-inline"');
  });

  it("snapshots export theme variables from the current LiveMD element", () => {
    let originalGetComputedStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      value: () => ({
        colorScheme: "normal",
        getPropertyValue(name: string) {
          return (
            {
              "--live-md-bg": "#282828",
              "--live-md-font-body": '"Geist Variable", ui-sans-serif',
              "--live-md-text": "#ebdbb2",
            }[name] ?? ""
          );
        },
      }),
    });
    try {
      let theme = snapshotMarkdownHtmlExportTheme({} as Element);

      expect(theme.colorScheme).toBe("dark");
      expect(theme.pageBackground).toBe("#282828");
      expect(theme.variables).toMatchObject({
        "--live-md-bg": "#282828",
        "--live-md-font-body": '"Geist Variable", ui-sans-serif',
        "--live-md-text": "#ebdbb2",
      });
    } finally {
      if (originalGetComputedStyle) {
        Object.defineProperty(globalThis, "getComputedStyle", originalGetComputedStyle);
      } else {
        delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
      }
    }
  });
});
