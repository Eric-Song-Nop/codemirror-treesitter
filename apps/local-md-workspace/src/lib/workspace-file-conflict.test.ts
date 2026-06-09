import { describe, expect, it } from "vite-plus/test";
import {
  detectWorkspaceFileConflict,
  isWorkspaceWriteConflictError,
  readWorkspaceFileWriteConflict,
} from "./workspace-file-conflict.ts";
import { hashMarkdownText } from "./markdown-hash.ts";
import type { MarkdownDirectoryNode, WorkspaceBackend } from "./workspace-backend.ts";

describe("workspace file conflicts", () => {
  it("does not report a conflict when the visible file still matches the base hash", async () => {
    let backend = createMemoryBackend([["note.md", "# First\n"]]);

    await expect(
      detectWorkspaceFileConflict(
        backend,
        "note.md",
        hashMarkdownText("# First\n"),
        "# Local edit\n",
      ),
    ).resolves.toBeNull();
  });

  it("does not report a conflict when the visible file already has the editor value", async () => {
    let backend = createMemoryBackend([["note.md", "# Local edit\n"]]);

    await expect(
      detectWorkspaceFileConflict(
        backend,
        "note.md",
        hashMarkdownText("# First\n"),
        "# Local edit\n",
      ),
    ).resolves.toBeNull();
  });

  it("reports a conflict when both the visible file and editor changed", async () => {
    let backend = createMemoryBackend([["note.md", "# External edit\n"]]);

    await expect(
      detectWorkspaceFileConflict(
        backend,
        "note.md",
        hashMarkdownText("# First\n"),
        "# Local edit\n",
      ),
    ).resolves.toMatchObject({
      externalHash: hashMarkdownText("# External edit\n"),
      externalValue: "# External edit\n",
      kind: "external-change",
      localHash: hashMarkdownText("# Local edit\n"),
      path: "note.md",
    });
  });

  it("turns Dropbox-style write conflicts into file conflicts", async () => {
    let backend = createMemoryBackend([["note.md", "# External edit\n"]]);

    await expect(
      readWorkspaceFileWriteConflict(
        backend,
        "note.md",
        hashMarkdownText("# First\n"),
        "# Local edit\n",
        new Error("POST https://content.dropboxapi.com/2/files/upload 409 Conflict"),
      ),
    ).resolves.toMatchObject({
      externalValue: "# External edit\n",
      kind: "write-conflict",
      path: "note.md",
    });
  });

  it("does not classify missing Dropbox paths as save conflicts", () => {
    expect(
      isWorkspaceWriteConflictError(
        new Error("OpenDAL Dropbox API error 409 Conflict: path/not_found"),
      ),
    ).toBe(false);
  });
});

type MemoryBackend = WorkspaceBackend & {
  files: Map<string, string>;
};

function createMemoryBackend(entries: Array<[string, string]>): MemoryBackend {
  let files = new Map(entries);

  return {
    files,
    id: "memory:test",
    kind: "local",
    name: "Memory",
    async createFile(path) {
      files.set(path, "");
      return path;
    },
    async deleteFile(path) {
      files.delete(path);
    },
    async readFile(path) {
      let value = files.get(path);
      if (value == null) throw new DOMException("File not found.", "NotFoundError");
      return value;
    },
    async readTree(): Promise<MarkdownDirectoryNode> {
      return { children: [], kind: "directory", name: "Memory", path: "" };
    },
    async renameFile(from, to) {
      let value = files.get(from);
      if (value == null) throw new DOMException("File not found.", "NotFoundError");
      files.delete(from);
      files.set(to, value);
      return to;
    },
    async writeFile(path, value) {
      files.set(path, value);
    },
  };
}
