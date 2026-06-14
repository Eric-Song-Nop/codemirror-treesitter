import {
  readAccessFileHandle,
  writeAccessFileHandle,
  type AccessFileHandle,
} from "@/lib/file-system";
import {
  loadSingleFileDraft,
  rememberLastSingleFileDraft,
  saveSingleFileDraft,
  type SingleFileDraft,
} from "@/lib/single-file-draft-store";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";

export function createSingleFileDraftBackend(draft: SingleFileDraft): WorkspaceBackend {
  let file = singleFileMarkdownNode(draft.name);
  return {
    id: `draft:${draft.id}`,
    kind: "local",
    name: "Draft",
    createFile: unsupportedSingleFileOperation,
    deleteFile: unsupportedSingleFileVoidOperation,
    async readFile() {
      return (await loadSingleFileDraft(draft.id))?.value ?? draft.value;
    },
    async readTree() {
      return {
        children: [file],
        kind: "directory",
        name: "Draft",
        path: "",
      };
    },
    renameFile: unsupportedSingleFileRenameOperation,
    async writeFile(_path, value) {
      let current = await loadSingleFileDraft(draft.id);
      let now = Date.now();
      await saveSingleFileDraft({
        createdAt: current?.createdAt ?? draft.createdAt,
        id: draft.id,
        name: current?.name ?? draft.name,
        updatedAt: now,
        value,
      });
      await rememberLastSingleFileDraft(draft.id);
    },
  };
}

export function createLocalFileBackend(handle: AccessFileHandle): WorkspaceBackend {
  let file = singleFileMarkdownNode(handle.name || "Untitled.md");
  return {
    id: `local-file:${file.name}`,
    kind: "local",
    name: "Local file",
    createFile: unsupportedSingleFileOperation,
    deleteFile: unsupportedSingleFileVoidOperation,
    readFile: () => readAccessFileHandle(handle),
    async readTree() {
      return {
        children: [file],
        kind: "directory",
        name: "Local file",
        path: "",
      };
    },
    renameFile: unsupportedSingleFileRenameOperation,
    writeFile: (_path, value) => writeAccessFileHandle(handle, value),
  };
}

export function singleFileMarkdownNode(pathOrName: string): MarkdownFileNode {
  let path = markdownDownloadFileName(pathOrName);
  return {
    kind: "file",
    name: path.split("/").at(-1) ?? path,
    path,
  };
}

export function markdownDownloadFileName(fileName: string) {
  let trimmed = fileName.trim() || "Untitled.md";
  return /\.md$/i.test(trimmed) || /\.markdown$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

async function unsupportedSingleFileOperation(): Promise<string | null> {
  throw new Error("This document is not a workspace.");
}

async function unsupportedSingleFileRenameOperation(): Promise<string> {
  throw new Error("This document is not a workspace.");
}

async function unsupportedSingleFileVoidOperation(): Promise<void> {
  throw new Error("This document is not a workspace.");
}
