import { describe, expect, it } from "vite-plus/test";
import {
  buildMarkdownDirectoryFromEntries,
  buildMarkdownTreeFromEntries,
  buildMarkdownTreeFromPaths,
  findMarkdownFile,
  replaceMarkdownDirectory,
  flattenMarkdownFiles,
  normalizeMarkdownFileName,
  normalizeMarkdownPath,
  normalizeWorkspaceCreateTarget,
  starterMarkdown,
} from "./workspace-tree.ts";

describe("workspace tree and path helpers", () => {
  it("normalizes user-provided Markdown paths", () => {
    expect(normalizeMarkdownPath(" notes\\daily ")).toBe("notes/daily.md");
    expect(normalizeMarkdownPath("notes/README.MD")).toBe("notes/README.MD");
    expect(normalizeMarkdownFileName("daily")).toBe("daily.md");
    expect(normalizeMarkdownFileName("daily.md")).toBe("daily.md");
  });

  it("normalizes create targets for files and folders", () => {
    expect(normalizeWorkspaceCreateTarget(" file.md ")).toEqual({
      kind: "file",
      path: "file.md",
    });
    expect(normalizeWorkspaceCreateTarget("notes/daily")).toEqual({
      kind: "file",
      path: "notes/daily.md",
    });
    expect(normalizeWorkspaceCreateTarget(" notes\\daily/ ")).toEqual({
      kind: "directory",
      path: "notes/daily",
    });
  });

  it("rejects traversal and path-like file names", () => {
    expect(() => normalizeMarkdownPath("../secret.md")).toThrow("File paths cannot include");
    expect(() => normalizeWorkspaceCreateTarget("../secret.md")).toThrow(
      "File paths cannot include",
    );
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
    expect(findMarkdownFile(tree, "notes/10.md")).toEqual({
      kind: "file",
      name: "10.md",
      path: "notes/10.md",
    });
    expect(findMarkdownFile(tree, "notes/missing.md")).toBeNull();
  });

  it("synthesizes empty directories from backend entries", () => {
    let tree = buildMarkdownTreeFromEntries("Dropbox", [
      { isDirectory: true, isFile: false, path: "drafts" },
      { isDirectory: true, isFile: false, path: "notes/archive" },
      { isDirectory: false, isFile: true, path: "notes/today.md" },
    ]);

    expect(tree.children).toMatchObject([
      { children: [], kind: "directory", name: "drafts", path: "drafts" },
      {
        children: [
          { children: [], kind: "directory", name: "archive", path: "notes/archive" },
          { kind: "file", name: "today.md", path: "notes/today.md" },
        ],
        kind: "directory",
        name: "notes",
        path: "notes",
      },
    ]);
  });

  it("builds one directory level from backend entries", () => {
    let directory = buildMarkdownDirectoryFromEntries("notes", "notes", [
      { isDirectory: true, isFile: false, path: "notes/archive" },
      { isDirectory: false, isFile: true, path: "notes/archive/2026.md" },
      { isDirectory: false, isFile: true, path: "notes/today.md" },
      { isDirectory: false, isFile: true, path: "notes/image.png" },
    ]);

    expect(directory).toMatchObject({
      children: [
        { children: [], childrenLoaded: false, kind: "directory", name: "archive" },
        { kind: "file", name: "today.md", path: "notes/today.md" },
      ],
      childrenLoaded: true,
      kind: "directory",
      name: "notes",
      path: "notes",
    });
  });

  it("replaces a loaded directory while preserving loaded child directories", () => {
    let tree = buildMarkdownTreeFromEntries("Workspace", [
      { isDirectory: true, isFile: false, path: "notes/archive" },
      { isDirectory: false, isFile: true, path: "notes/archive/2026.md" },
    ]);
    let nextNotes = buildMarkdownDirectoryFromEntries("notes", "notes", [
      { isDirectory: true, isFile: false, path: "notes/archive" },
      { isDirectory: false, isFile: true, path: "notes/today.md" },
    ]);

    let nextTree = replaceMarkdownDirectory(tree, nextNotes);

    expect(nextTree.children[0]).toMatchObject({
      children: [
        {
          children: [{ kind: "file", name: "2026.md", path: "notes/archive/2026.md" }],
          childrenLoaded: true,
          kind: "directory",
          name: "archive",
        },
        { kind: "file", name: "today.md", path: "notes/today.md" },
      ],
      childrenLoaded: true,
      kind: "directory",
      name: "notes",
    });
  });
});
