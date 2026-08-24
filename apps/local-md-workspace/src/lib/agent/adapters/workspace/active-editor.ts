import type { EditorView } from "@codemirror/view";
import { normalizeWorkspaceAgentFilePath } from "../../application/workspace-catalog.ts";
import {
  workspaceAgentVersionConflicts,
  type WorkspaceAgentActiveDocument,
  type WorkspaceAgentActiveDocumentVersion,
  type WorkspaceAgentVersionConflict,
} from "../../domain/active-document.ts";

export type WorkspaceAgentActiveEditor = WorkspaceAgentActiveDocument & {
  view: EditorView;
};

export interface WorkspaceAgentActiveEditorCapability {
  getActiveEditor(): WorkspaceAgentActiveEditor | null;
}

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

export function workspaceAgentActiveEditorConflicts(input: {
  capture: WorkspaceAgentActiveEditorCapture;
  expected: WorkspaceAgentActiveDocumentVersion;
}): WorkspaceAgentVersionConflict[] {
  let conflicts = workspaceAgentVersionConflicts({
    document: input.capture.document,
    expected: input.expected,
  });
  if (!input.capture.editorValueMatches) conflicts.push("editorValue");
  return conflicts;
}
