import { describe, expect, it, vi } from "vite-plus/test";
import {
  createStandaloneMarkdownHtml,
  resolveMarkdownImagePath,
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
    expect(result.html).toContain("<h1>Today</h1>");
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

  it("resolves Markdown image paths relative to the current document", () => {
    expect(resolveMarkdownImagePath("assets/a.png", "notes/today.md")).toBe("notes/assets/a.png");
    expect(resolveMarkdownImagePath("../assets/a.png#v1", "notes/daily/today.md")).toBe(
      "notes/assets/a.png",
    );
    expect(resolveMarkdownImagePath("/assets/a.png", "notes/today.md")).toBe("assets/a.png");
    expect(resolveMarkdownImagePath("../../a.png", "notes/today.md")).toBeNull();
    expect(resolveMarkdownImagePath("https://example.com/a.png", "notes/today.md")).toBeNull();
  });
});
