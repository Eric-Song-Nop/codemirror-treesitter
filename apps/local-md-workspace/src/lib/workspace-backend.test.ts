import { describe, expect, it } from "vite-plus/test";
import {
  buildMarkdownTreeFromPaths,
  flattenMarkdownFiles,
  normalizeMarkdownFileName,
  normalizeMarkdownPath,
  starterMarkdown,
} from "./workspace-backend.ts";

describe("workspace backend path helpers", () => {
  it("normalizes user-provided Markdown paths", () => {
    expect(normalizeMarkdownPath(" notes\\daily ")).toBe("notes/daily.md");
    expect(normalizeMarkdownPath("notes/README.MD")).toBe("notes/README.MD");
    expect(normalizeMarkdownFileName("daily")).toBe("daily.md");
    expect(normalizeMarkdownFileName("daily.md")).toBe("daily.md");
  });

  it("rejects traversal and path-like file names", () => {
    expect(() => normalizeMarkdownPath("../secret.md")).toThrow("File paths cannot include");
    expect(() => normalizeMarkdownFileName("notes/daily.md")).toThrow(
      "Enter a file name, not a path.",
    );
  });

  it("creates starter Markdown from the normalized path", () => {
    expect(starterMarkdown("notes/daily-note.md")).toBe("# daily note\n");
    expect(starterMarkdown("notes/_draft.md")).toBe("# draft\n");
  });

  it("synthesizes a sorted Markdown tree from backend paths", () => {
    let tree = buildMarkdownTreeFromPaths("Dropbox", [
      "notes/today.md",
      "notes/tomorrow.txt",
      "notes/archive/2026.md",
      "root.md",
      "notes/10.md",
      "notes/2.md",
      "../ignored.md",
    ]);

    expect(tree.children.map((node) => node.name)).toEqual(["notes", "root.md"]);
    expect(tree.children[0]).toMatchObject({
      children: [
        {
          children: [{ kind: "file", name: "2026.md", path: "notes/archive/2026.md" }],
          kind: "directory",
          name: "archive",
          path: "notes/archive",
        },
        { kind: "file", name: "2.md", path: "notes/2.md" },
        { kind: "file", name: "10.md", path: "notes/10.md" },
        { kind: "file", name: "today.md", path: "notes/today.md" },
      ],
      kind: "directory",
      name: "notes",
      path: "notes",
    });
    expect(flattenMarkdownFiles(tree).map((file) => file.path)).toEqual([
      "notes/archive/2026.md",
      "notes/2.md",
      "notes/10.md",
      "notes/today.md",
      "root.md",
    ]);
  });
});
