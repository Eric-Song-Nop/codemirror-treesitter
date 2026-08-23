import {
  readAccessFileHandle,
  writeAccessFileHandle,
  type AccessFileHandle,
} from "@/lib/workspace/file-system";
import {
  loadSingleFileDraft,
  rememberLastSingleFileDraft,
  saveSingleFileDraft,
  type SingleFileDraft,
} from "@/lib/workspace/single-file-draft-store";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import type { StandaloneDocumentSource } from "@/lib/workspace/types";

export function createSingleFileDraftSource(draft: SingleFileDraft): StandaloneDocumentSource {
  return {
    id: `draft:${draft.id}`,
    kind: "standalone",
    async readFile() {
      return (await loadSingleFileDraft(draft.id))?.value ?? draft.value;
    },
    async writeFile(value) {
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

export function createLocalFileSource(handle: AccessFileHandle): StandaloneDocumentSource {
  let file = singleFileMarkdownNode(handle.name || "Untitled.md");
  return {
    id: `local-file:${file.name}`,
    kind: "standalone",
    readFile: () => readAccessFileHandle(handle),
    writeFile: (value) => writeAccessFileHandle(handle, value),
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
