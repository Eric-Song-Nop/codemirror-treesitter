import type { WorkspaceCollaborativeDocument } from "@/lib/workspace/documents";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import {
  documentSourceDocumentIdInput,
  documentSourceRef,
  sameDocumentSourceRef,
  type DocumentSourceRef,
} from "@/lib/workspace/source-identity";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

export type WorkspaceDocumentContext = {
  collabDocument: WorkspaceCollaborativeDocument;
  file: MarkdownFileNode;
  id: string;
  runtime: WorkspaceRuntime;
  sourceRef: DocumentSourceRef;
};

export function createWorkspaceDocumentContext(
  runtime: WorkspaceRuntime,
  file: MarkdownFileNode,
  collabDocument: WorkspaceCollaborativeDocument,
): WorkspaceDocumentContext {
  let sourceRef = documentSourceRef(runtime.identity, file.path);
  return {
    collabDocument,
    file,
    id: documentSourceDocumentIdInput(sourceRef),
    runtime,
    sourceRef,
  };
}

export function workspaceDocumentContextMatchesSource(
  context: WorkspaceDocumentContext,
  sourceRef: DocumentSourceRef,
) {
  return sameDocumentSourceRef(context.sourceRef, sourceRef);
}
