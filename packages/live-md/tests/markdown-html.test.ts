import { readFileSync } from "node:fs";
import { languages } from "@codemirror-treesitter/language-data";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
  liveMdMarkdownFeature,
  liveMdMarkdownDocumentClass,
  liveMdMarkdownDocumentCss,
  liveMdMarkdownDocumentCssVariables,
  renderMarkdownToHtml,
  type LiveMdMarkdownFeature,
} from "../src/index.js";

vi.mock("beautiful-mermaid", () => ({
  renderMermaidSVG(source: string) {
    if (source.includes("BROKEN")) throw new Error("beautiful-mermaid failed");
    if (source.includes("NOT_SVG")) return "<p>not svg</p>";
    if (source.includes("UNSAFE")) {
      return [
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">',
        "<script>alert(1)</script>",
        "<foreignObject><div>bad</div></foreignObject>",
        '<a href="jav&#x61;script:alert(1)"><text>bad link</text></a>',
        '<use xlink:href="javascript:alert(1)" xmlns:xlink="http://www.w3.org/1999/xlink"></use>',
        '<style>@import url("https://example.com/bad.css"); .node { fill: url(javascript:alert(1)); }</style>',
        '<text style="fill: url(javascript:alert(1)); stroke: var(--live-md-text)" onclick="alert(1)">safe</text>',
        "</svg>",
      ].join("");
    }
    return [
      '<svg xmlns="http://www.w3.org/2000/svg" style="--bg: var(--live-md-bg)">',
      "<style>text { font-family: var(--live-md-mermaid-font, var(--live-md-font-ui)); }</style>",
      `<text fill="var(--live-md-mermaid-text)">${source}</text>`,
      "</svg>",
    ].join("");
  },
}));

vi.mock("mermaid", () => ({
  default: {
    initialize() {},
    async render(_id: string, source: string) {
      if (source.includes("BROKEN")) throw new Error("mermaid failed");
      return {
        svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${source}</text></svg>`,
      };
    },
  },
}));

describe("Tree-sitter Markdown HTML rendering", () => {
  let originalDomParser: typeof DOMParser | undefined;
  let originalElement: typeof Element | undefined;
  let originalXmlSerializer: typeof XMLSerializer | undefined;

  beforeAll(() => {
    let window = new Window();
    originalDomParser = globalThis.DOMParser;
    originalElement = globalThis.Element;
    originalXmlSerializer = globalThis.XMLSerializer;
    Object.assign(globalThis, {
      DOMParser: window.DOMParser,
      Element: window.Element,
      XMLSerializer: window.XMLSerializer,
    });
  });

  afterAll(() => {
    restoreGlobal("DOMParser", originalDomParser);
    restoreGlobal("Element", originalElement);
    restoreGlobal("XMLSerializer", originalXmlSerializer);
  });

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
    expect(html).toContain('<div class="cm-md-table-preview">');
    expect(html).toContain("<table>");
    expect(html).toContain('<th style="text-align: left">Format</th>');
    expect(html).toContain('<td style="text-align: right">Ready</td>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://example.com">link</a>');
  });

  it("renders table cell contents through the inline parser", async () => {
    let html = await renderMarkdownToHtml(
      [
        "| Feature | Status |",
        "| --- | --- |",
        "| **bold** and _em_ | [docs](https://docs.example) and `code` |",
        "| ~~old~~ | <https://example.com> |",
      ].join("\n"),
    );

    expect(html).toContain("<td><strong>bold</strong> and <em>em</em></td>");
    expect(html).toContain(
      '<td><a href="https://docs.example">docs</a> and <code>code</code></td>',
    );
    expect(html).toContain("<td><del>old</del></td>");
    expect(html).toContain('<td><a href="https://example.com">https://example.com</a></td>');
  });

  it("renders LaTeX spans and display blocks with KaTeX HTML", async () => {
    let html = await renderMarkdownToHtml(
      ["Inline $x^2 + y^2$ formula.", "", "$$x^2$$", "", "$$", "a^2 + b^2 = c^2", "$$"].join("\n"),
    );

    expect(html).toContain(
      '<span class="cm-md-latex cm-md-latex-inline" data-source="$x^2 + y^2$">',
    );
    expect(html).toContain('<span class="katex">');
    expect(html).toContain('<div class="cm-md-latex cm-md-latex-display" data-source="$$x^2$$">');
    expect(html).toContain(
      '<div class="cm-md-latex cm-md-latex-display" data-source="$$\na^2 + b^2 = c^2\n$$">',
    );
    expect(html).toContain('<span class="katex-display">');
    expect(html).not.toContain("latex_span_delimiter");
  });

  it("renders LaTeX errors as themed fallback elements", async () => {
    let html = await renderMarkdownToHtml(
      ["Inline $\\sqrt{$ failure.", "", "$$", "\\frac{", "$$"].join("\n"),
    );

    expect(html).toContain(
      '<span class="cm-md-latex cm-md-latex-inline is-error" data-source="$\\sqrt{$"',
    );
    expect(html).toContain(
      '<div class="cm-md-latex cm-md-latex-display is-error" data-source="$$\n\\frac{\n$$"',
    );
    expect(html).toContain("KaTeX parse error");
    expect(html).not.toContain("katex-error");
  });

  it("renders Mermaid fences as themed preview containers", async () => {
    let html = await renderMarkdownToHtml(
      ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n"),
    );

    expect(html).toContain('<div class="cm-md-mermaid" data-source="flowchart TD\n  A --&gt; B">');
    expect(html).toContain('<div class="cm-md-mermaid-render"><svg');
    expect(html).toContain("A --&gt; B");
    expect(html).toContain("font-family: var(--live-md-mermaid-font");
    expect(html).toContain('style="--bg: var(--live-md-bg)"');
    expect(html).not.toContain('<pre><code class="language-mermaid">');
  });

  it("renders Mermaid errors as themed error previews", async () => {
    let html = await renderMarkdownToHtml(["```mmd", "BROKEN", "```"].join("\n"));

    expect(html).toContain('<div class="cm-md-mermaid is-error" data-source="BROKEN"');
    expect(html).toContain('title="mermaid failed"');
    expect(html).toContain(
      '<span class="cm-md-mermaid-message">Unable to render Mermaid diagram</span>',
    );
    expect(html).not.toContain('<pre><code class="language-mmd">');
  });

  it("sanitizes rendered Mermaid SVG before inlining it in exports", async () => {
    let html = await renderMarkdownToHtml(["```mermaid", "UNSAFE", "```"].join("\n"));

    expect(html).toContain('<div class="cm-md-mermaid-render"><svg');
    expect(html).toContain('<text style="stroke: var(--live-md-text)">safe</text>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<foreignObject");
    expect(html).not.toContain("xlink:href");
    expect(html).not.toContain("onload=");
    expect(html).not.toContain("onclick=");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("@import");
    expect(html).not.toContain("bad.css");
  });

  it("renders an error preview when Mermaid SVG cannot be safely parsed", async () => {
    let html = await renderMarkdownToHtml(["```mermaid", "NOT_SVG", "```"].join("\n"));

    expect(html).toContain('<div class="cm-md-mermaid is-error" data-source="NOT_SVG"');
    expect(html).toContain('title="Mermaid renderer returned non-SVG output"');
    expect(html).not.toContain("<p>not svg</p>");
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

  it("renders through explicit Markdown parsers without loading generic nested Markdown", async () => {
    let markdown = languages.find((language) => language.name == "Markdown")!;
    let load = vi.spyOn(markdown, "load").mockRejectedValue(new Error("generic Markdown loaded"));

    try {
      await expect(renderMarkdownToHtml("**bold** and [link](https://example.com)")).resolves.toBe(
        '<p><strong>bold</strong> and <a href="https://example.com">link</a></p>',
      );
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it("normalizes CRLF input before slicing syntax nodes", async () => {
    let html = await renderMarkdownToHtml("# Windows\r\n\r\n![Chart](assets/chart.png)\r\n");

    expect(html).toContain("<h1>Windows</h1>");
    expect(html).toContain('<img src="assets/chart.png" alt="Chart">');
    expect(html).not.toContain("\r");
  });

  it("lets markdown features render matched blocks to HTML", async () => {
    let callout = liveMdMarkdownFeature({
      name: "callout-html",
      query: "(paragraph) @html",
      async renderHtml({ renderInline, slice, target }) {
        let source = slice(target).trim();
        if (!source.startsWith(":::note")) return null;
        let body = source.slice(":::note".length).trim();
        return `<aside class="live-md-callout">${await renderInline(body)}</aside>`;
      },
    });

    let html = await renderMarkdownToHtml(":::note **Heads up**\n\nPlain paragraph", {
      markdown: { features: [callout] },
    });

    expect(html).toBe(
      '<aside class="live-md-callout"><strong>Heads up</strong></aside>\n<p>Plain paragraph</p>',
    );
  });

  it("gives HTML feature hooks access to the default block renderer", async () => {
    let wrapper = liveMdMarkdownFeature({
      name: "heading-wrapper",
      query: "(atx_heading) @html",
      async renderHtml({ renderDefault }) {
        return `<section class="heading-frame">${await renderDefault()}</section>`;
      },
    });

    let html = await renderMarkdownToHtml("# Exported", {
      markdown: { features: [wrapper] },
    });

    expect(html).toBe('<section class="heading-frame"><h1>Exported</h1></section>');
  });

  it("applies HTML features in markdown feature priority order", async () => {
    let late = htmlHeadingFeature("late", 10);
    let early = htmlHeadingFeature("early", -1);

    let html = await renderMarkdownToHtml("# Priority", {
      markdown: { features: [late, early] },
    });

    expect(html).toBe('<h1 data-feature="early">Priority</h1>');
  });

  it("does not use editor-only decorate hooks during HTML rendering", async () => {
    let decorate = vi.fn();
    let feature: LiveMdMarkdownFeature = {
      decorate,
      name: "editor-only",
      query: "(paragraph) @html",
    };

    let html = await renderMarkdownToHtml("Only HTML", {
      markdown: { features: [feature] },
    });

    expect(html).toBe("<p>Only HTML</p>");
    expect(decorate).not.toHaveBeenCalled();
  });

  it("keeps HTML feature rendering block-only even when includeNested is set", async () => {
    let renderHtml = vi.fn(() => "<strong>Replaced</strong>");
    let feature: LiveMdMarkdownFeature = {
      includeNested: true,
      name: "inline-html",
      query: "(inline) @html",
      renderHtml,
    };

    let html = await renderMarkdownToHtml("Use *emphasis* here", {
      markdown: { features: [feature] },
    });

    expect(html).toBe("<p>Use <em>emphasis</em> here</p>");
    expect(renderHtml).not.toHaveBeenCalled();
  });

  it("exports scoped document CSS driven by LiveMD variables", () => {
    let css = liveMdMarkdownDocumentCss();

    expect(liveMdMarkdownDocumentClass).toBe("live-md-document");
    expect(liveMdMarkdownDocumentCssVariables).toContain("--live-md-bg");
    expect(liveMdMarkdownDocumentCssVariables).toContain("--live-md-font-body");
    expect(liveMdMarkdownDocumentCssVariables).toContain("--live-md-list-marker");
    expect(css).toContain(".live-md-document h1");
    expect(css).toContain(".live-md-document .live-md-task-item.is-checked");
    expect(css).toContain(".katex .katex-mathml");
    expect(css).toContain(".live-md-document .cm-md-latex-inline .katex");
    expect(css).toContain(".live-md-document .cm-md-latex.is-error");
    expect(css).toContain(".live-md-document .cm-md-mermaid");
    expect(css).toContain(".live-md-document .cm-md-table-preview");
    expect(css).toContain("object-fit: contain");
    expect(css).toContain("--live-md-mermaid-accent");
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

function restoreGlobal(name: "DOMParser" | "Element" | "XMLSerializer", value: unknown) {
  if (value) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  } else {
    delete (globalThis as Record<string, unknown>)[name];
  }
}

function htmlHeadingFeature(name: string, priority: number): LiveMdMarkdownFeature {
  return liveMdMarkdownFeature({
    name,
    priority,
    query: "(atx_heading heading_content: (inline) @content) @html",
    async renderHtml({ node, renderInline }) {
      let content = node("content");
      return `<h1 data-feature="${name}">${content ? await renderInline(content) : ""}</h1>`;
    },
  });
}
