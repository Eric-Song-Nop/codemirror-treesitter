import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";
import {
  documentSourceDocumentIdInput,
  documentSourceRef,
  sameDocumentSourceRef,
  type DocumentSourceRef,
} from "@/lib/workspace/source-identity";

export type DocumentSession = {
  backend: WorkspaceBackend;
  collabDocument: CollabDocumentState;
  file: MarkdownFileNode;
  id: string;
  sourceRef: DocumentSourceRef;
};

export function createDocumentSession(
  backend: WorkspaceBackend,
  file: MarkdownFileNode,
  collabDocument: CollabDocumentState,
): DocumentSession {
  let sourceRef = documentSourceRef(backend, file.path);
  return {
    backend,
    collabDocument,
    file,
    id: documentSourceDocumentIdInput(sourceRef),
    sourceRef,
  };
}

export function documentSessionMatchesSource(
  session: DocumentSession,
  sourceRef: DocumentSourceRef,
) {
  return sameDocumentSourceRef(session.sourceRef, sourceRef);
}
