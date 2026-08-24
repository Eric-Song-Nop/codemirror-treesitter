import { hashMarkdownText } from "../collaboration/markdown-hash.ts";
import { normalizeWorkspaceAgentFilePath } from "./workspace-catalog.ts";
import type {
  WorkspaceAgentActiveDocument,
  WorkspaceAgentActiveDocumentVersion,
  WorkspaceAgentActiveEditor,
  WorkspaceAgentActiveEditorCapability,
  WorkspaceAgentVersionConflict,
} from "./contracts.ts";

export type WorkspaceAgentActiveEditorCapture = {
  document: WorkspaceAgentActiveDocument;
  editorValueMatches: boolean;
  view: WorkspaceAgentActiveEditor["view"];
};

export function captureWorkspaceAgentActiveEditor(
  capability: WorkspaceAgentActiveEditorCapability | undefined,
): WorkspaceAgentActiveEditorCapture | null {
  let active = capability?.getActiveEditor();
  if (!active) return null;
  let path = normalizeWorkspaceAgentFilePath(active.path);
  if (!path) return null;
  let editorValue = active.view.state.doc.toString();
  return {
    document: {
      documentGeneration: active.documentGeneration,
      documentId: active.documentId,
      dirty: active.dirty,
      editVersion: active.editVersion,
      path,
      targetGeneration: active.targetGeneration,
      value: editorValue,
      workspaceId: active.workspaceId,
    },
    editorValueMatches: active.value == editorValue,
    view: active.view,
  };
}

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
  capture: WorkspaceAgentActiveEditorCapture;
  expected: WorkspaceAgentActiveDocumentVersion;
}): WorkspaceAgentVersionConflict[] {
  let conflicts: WorkspaceAgentVersionConflict[] = [];
  let current = workspaceAgentActiveDocumentVersion(input.capture.document);
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
  if (!input.capture.editorValueMatches) conflicts.push("editorValue");
  return conflicts;
}
