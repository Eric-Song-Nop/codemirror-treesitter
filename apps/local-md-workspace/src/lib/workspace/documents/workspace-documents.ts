import { openMarkdownCollabDocument } from "@/lib/collaboration/markdown-document";
import type {
  WorkspaceDocumentChangeSource,
  WorkspaceDocumentPort,
  WorkspaceIdentity,
} from "@/lib/workspace/runtime/types";
import {
  ManagedCollaborativeDocument,
  normalizeWorkspaceDocumentPath,
} from "./collaborative-document.ts";
import type { WorkspaceCollaborativeDocument, WorkspaceDocuments } from "./contracts.ts";

export type WorkspaceDocumentsOptions = {
  changes: WorkspaceDocumentChangeSource | null;
  documentSource: WorkspaceDocumentPort;
  identity: WorkspaceIdentity;
};

export class DefaultWorkspaceDocuments implements WorkspaceDocuments {
  private closeRequest: Promise<void> | null = null;
  private readonly documents = new Map<string, Promise<ManagedCollaborativeDocument>>();

  constructor(private readonly options: WorkspaceDocumentsOptions) {}

  document(rawPath: string): Promise<WorkspaceCollaborativeDocument> {
    if (this.closeRequest) {
      return Promise.reject(new Error("The workspace document registry is closed."));
    }

    let path = normalizeWorkspaceDocumentPath(rawPath);
    let existing = this.documents.get(path);
    if (existing) return existing;

    let request = this.open(path);
    this.documents.set(path, request);
    void request.catch(() => {
      if (this.documents.get(path) === request) this.documents.delete(path);
    });
    return request;
  }

  close() {
    return (this.closeRequest ??= this.closeDocuments());
  }

  private async open(path: string) {
    let state = await openMarkdownCollabDocument(
      { documentSource: this.options.documentSource, identity: this.options.identity },
      path,
    );
    return new ManagedCollaborativeDocument({ ...this.options, path, state });
  }

  private async closeDocuments() {
    let opened = await Promise.allSettled(this.documents.values());
    let closed = await Promise.allSettled(
      opened.flatMap((result) => (result.status == "fulfilled" ? [result.value.close()] : [])),
    );
    this.documents.clear();

    let errors = closed.flatMap((result) => (result.status == "rejected" ? [result.reason] : []));
    if (errors.length == 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Workspace documents failed to close.");
  }
}
