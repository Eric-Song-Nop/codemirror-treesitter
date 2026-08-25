import type { WorkspaceCollaborativeDocument } from "@/lib/workspace/documents";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import {
  documentSourceDocumentIdInput,
  documentSourceRef,
  sameDocumentSourceRef,
  type DocumentSourceRef,
} from "@/lib/workspace/source-identity";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

export type DocumentSession = {
  collabDocument: WorkspaceCollaborativeDocument;
  file: MarkdownFileNode;
  id: string;
  runtime: WorkspaceRuntime;
  sourceRef: DocumentSourceRef;
};

export type ActiveWorkspaceDocumentSession = DocumentSession & {
  epoch: number;
};

export function createDocumentSession(
  runtime: WorkspaceRuntime,
  file: MarkdownFileNode,
  collabDocument: WorkspaceCollaborativeDocument,
): DocumentSession {
  let sourceRef = documentSourceRef(runtime.identity, file.path);
  return {
    collabDocument,
    file,
    id: documentSourceDocumentIdInput(sourceRef),
    runtime,
    sourceRef,
  };
}

export function documentSessionMatchesSource(
  session: DocumentSession,
  sourceRef: DocumentSourceRef,
) {
  return sameDocumentSourceRef(session.sourceRef, sourceRef);
}
