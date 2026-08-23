import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import {
  documentSourceDocumentIdInput,
  documentSourceRef,
  sameDocumentSourceRef,
  type DocumentSourceRef,
} from "@/lib/workspace/source-identity";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

export type DocumentSession = {
  collabDocument: CollabDocumentState;
  file: MarkdownFileNode;
  id: string;
  runtime: WorkspaceRuntime;
  sourceRef: DocumentSourceRef;
};

export function createDocumentSession(
  runtime: WorkspaceRuntime,
  file: MarkdownFileNode,
  collabDocument: CollabDocumentState,
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
