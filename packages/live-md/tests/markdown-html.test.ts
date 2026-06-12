import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  liveMdMarkdownDocumentClass,
  liveMdMarkdownDocumentCss,
  liveMdMarkdownDocumentCssVariables,
  renderMarkdownToHtml,
} from "../src/index.js";

describe("Tree-sitter Markdown HTML rendering", () => {
  it("renders common Markdown blocks and inline marks", async () => {
    let html = await renderMarkdownToHtml(
      [
        "# Today",
        "",
        "- [x] Ship export",
        "- [ ] Add PDF later",
        "",
        "| Format | Status |",
        "| :--- | ---: |",
        "| HTML | Ready |",
        "",
        "**bold** *em* `code` [link](https://example.com)",
      ].join("\n"),
    );

    expect(html).toContain("<h1>Today</h1>");
    expect(html).toContain('<li class="live-md-task-item is-checked">');
    expect(html).toContain('<input checked="" disabled="" type="checkbox"> Ship export');
    expect(html).toContain('<li class="live-md-task-item">');
    expect(html).toContain('<input disabled="" type="checkbox"> Add PDF later');
    expect(html).toContain("<table>");
    expect(html).toContain('<th style="text-align: left">Format</th>');
    expect(html).toContain('<td style="text-align: right">Ready</td>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://example.com">link</a>');
  });

  it("resolves image sources without rendering raw Markdown syntax", async () => {
    let resolveImageSource = vi.fn(() => "data:image/png;base64,AQID");
    let html = await renderMarkdownToHtml('![**Chart**](assets/chart.png "Draft")', {
      resolveImageSource,
    });

    expect(resolveImageSource).toHaveBeenCalledWith({
      alt: "Chart",
      source: "assets/chart.png",
      title: "Draft",
    });
    expect(html).toBe('<p><img src="data:image/png;base64,AQID" alt="Chart" title="Draft"></p>');
  });

  it("escapes raw HTML and strips block continuation markers", async () => {
    let html = await renderMarkdownToHtml(
      ['<script>alert("x")</script>', "", "> quote", "> more"].join("\n"),
    );

    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<blockquote>\n<p>quote\nmore</p>\n</blockquote>");
  });

  it("renders code blocks, ordered starts, and setext headings", async () => {
    let html = await renderMarkdownToHtml(
      [
        "Release",
        "=======",
        "",
        "3. first",
        "4. second",
        "",
        "```ts",
        'const tag = "<ok>";',
        "```",
      ].join("\n"),
    );

    expect(html).toContain("<h1>Release</h1>");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("<li>first</li>");
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain("const tag = &quot;&lt;ok&gt;&quot;");
  });

  it("renders extended inline syntax through the tree-sitter inline parser", async () => {
    let html = await renderMarkdownToHtml(
      [
        "~~done~~ <https://example.com> <me@example.com>",
        "line one\\",
        "line two <span>raw</span>",
      ].join("\n"),
    );

    expect(html).toContain("<del>done</del>");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
    expect(html).toContain('<a href="mailto:me@example.com">me@example.com</a>');
    expect(html).toContain("line one<br>");
    expect(html).toContain("line two &lt;span&gt;raw&lt;/span&gt;");
  });

  it("normalizes CRLF input before slicing syntax nodes", async () => {
    let html = await renderMarkdownToHtml("# Windows\r\n\r\n![Chart](assets/chart.png)\r\n");

    expect(html).toContain("<h1>Windows</h1>");
    expect(html).toContain('<img src="assets/chart.png" alt="Chart">');
    expect(html).not.toContain("\r");
  });

  it("exports scoped document CSS driven by LiveMD variables", () => {
    let css = liveMdMarkdownDocumentCss();

    expect(liveMdMarkdownDocumentClass).toBe("live-md-document");
    expect(liveMdMarkdownDocumentCssVariables).toContain("--live-md-bg");
    expect(liveMdMarkdownDocumentCssVariables).toContain("--live-md-font-body");
    expect(liveMdMarkdownDocumentCssVariables).toContain("--live-md-list-marker");
    expect(css).toContain(".live-md-document h1");
    expect(css).toContain(".live-md-document .live-md-task-item.is-checked");
    expect(css).toContain("var(--live-md-bg, #fffdfa)");
    expect(css).toContain("var(--live-md-list-marker, #0f766e)");
    expect(css).not.toMatch(/(^|\n)h1\s*\{/);
    expect(css).not.toContain(":has(");
    expect(css).not.toContain(":root");
  });

  it("keeps exported theme variables aligned with the public LiveMD host token contract", () => {
    let style = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    let hostBlock = /:host\s*\{(?<body>[\s\S]*?)\n\}/.exec(style)?.groups?.body ?? "";
    let publicVariables = Array.from(
      new Set(hostBlock.match(/--live-md-[a-z0-9-]+(?=\s*:)/g) ?? []),
    );

    expect(publicVariables).toHaveLength(62);
    expect(liveMdMarkdownDocumentCssVariables).toEqual(publicVariables);
  });
});
