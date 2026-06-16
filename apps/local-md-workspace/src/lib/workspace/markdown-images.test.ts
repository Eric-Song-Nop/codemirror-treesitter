import { describe, expect, it } from "vite-plus/test";
import { resolveMarkdownImagePath } from "./markdown-images.ts";

describe("workspace Markdown images", () => {
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
