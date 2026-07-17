import { Text } from "@codemirror/state";
import { TreeSitterLanguage, TreeSitterParser } from "@codemirror-treesitter/language";
import { describe, expect, it, vi } from "vite-plus/test";
import { loadLiveMdCodeFenceLanguage, loadMarkdownParserService } from "../src/live-md.js";

describe("focused LiveMD language-data entry", () => {
  it("loads the standalone Markdown block and inline parser service", async () => {
    let service = await loadMarkdownParserService();
    let tree = service.blockParser.parse(Text.of(["# Heading", "", "_body_"]));

    try {
      expect(service.blockLanguage.language).toBeInstanceOf(TreeSitterLanguage);
      expect(tree.topNode.name).toBe("document");
    } finally {
      tree.tree?.delete();
    }
  });

  it("caches aliases for one requested code-fence grammar and rejects unsupported names", async () => {
    let byAlias = await loadLiveMdCodeFenceLanguage("ts");
    let byName = await loadLiveMdCodeFenceLanguage("typescript");

    expect(byAlias).not.toBeNull();
    expect(byName?.parser).toBe(byAlias?.parser);
    expect(byAlias?.aliases).toContain("mts");
    await expect(loadLiveMdCodeFenceLanguage("not-a-language")).resolves.toBeNull();
  });

  it("does not permanently cache a rejected code-fence grammar load", async () => {
    let load = vi.spyOn(TreeSitterParser, "load").mockRejectedValueOnce(new Error("temporary"));
    try {
      await expect(loadLiveMdCodeFenceLanguage("css")).rejects.toThrow("temporary");
    } finally {
      load.mockRestore();
    }

    await expect(loadLiveMdCodeFenceLanguage("css")).resolves.toMatchObject({
      aliases: ["css"],
    });
  });
});
