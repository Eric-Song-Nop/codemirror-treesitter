import { hashMarkdownText } from "../../collaboration/markdown-hash.ts";

export type WorkspaceAgentActiveDocument = {
  documentGeneration: number;
  documentId: string;
  dirty: boolean;
  editVersion: number;
  path: string;
  targetGeneration: number;
  value: string;
  workspaceId: string;
};

export type WorkspaceAgentActiveDocumentVersion = {
  contentHash: string;
  documentGeneration: number;
  documentId: string;
  editVersion: number;
  path: string;
  targetGeneration: number;
  version: 1;
  workspaceId: string;
};

export type WorkspaceAgentVersionConflict =
  | "contentHash"
  | "documentGeneration"
  | "documentId"
  | "editVersion"
  | "editorValue"
  | "path"
  | "targetGeneration"
  | "version"
  | "workspaceId";

export function workspaceAgentActiveDocumentVersion(
  document: WorkspaceAgentActiveDocument,
): WorkspaceAgentActiveDocumentVersion {
  return {
    contentHash: hashMarkdownText(document.value),
    documentGeneration: document.documentGeneration,
    documentId: document.documentId,
    editVersion: document.editVersion,
    path: document.path,
    targetGeneration: document.targetGeneration,
    version: 1,
    workspaceId: document.workspaceId,
  };
}

export function workspaceAgentVersionConflicts(input: {
  document: WorkspaceAgentActiveDocument;
  expected: WorkspaceAgentActiveDocumentVersion;
}): WorkspaceAgentVersionConflict[] {
  let conflicts: WorkspaceAgentVersionConflict[] = [];
  let current = workspaceAgentActiveDocumentVersion(input.document);
  for (let field of [
    "version",
    "workspaceId",
    "documentId",
    "path",
    "documentGeneration",
    "editVersion",
    "targetGeneration",
    "contentHash",
  ] as const) {
    if (input.expected[field] != current[field]) conflicts.push(field);
  }
  return conflicts;
}
