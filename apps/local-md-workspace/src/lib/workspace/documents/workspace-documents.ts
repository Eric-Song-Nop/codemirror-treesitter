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

/** Unretained documents close after this idle period unless reacquired. */
export const WORKSPACE_DOCUMENT_IDLE_CLOSE_MS = 60_000;
/** Backstop on resident documents; only idle, saved, unretained ones are evicted. */
export const WORKSPACE_DOCUMENT_MAX_LIVE = 32;

export type WorkspaceDocumentsOptions = {
  changes: WorkspaceDocumentChangeSource | null;
  documentSource: WorkspaceDocumentPort;
  identity: WorkspaceIdentity;
  idleCloseMs?: number;
  maxLiveDocuments?: number;
};

type Timer = ReturnType<typeof setTimeout>;

type DocumentEntry = {
  document: ManagedCollaborativeDocument | null;
  idleTimer: Timer | null;
  lastUsed: number;
  refs: number;
  request: Promise<ManagedCollaborativeDocument> | null;
};

/**
 * Reference-counted registry. `document(path)` resolves a shared instance;
 * long-lived users (editor views, Agent edits) hold it with `retain()`. An
 * unretained document closes after an idle period, and an LRU cap evicts the
 * oldest idle documents. Documents with unsaved changes are never evicted.
 */
export class DefaultWorkspaceDocuments implements WorkspaceDocuments {
  private closeRequest: Promise<void> | null = null;
  private readonly documents = new Map<string, DocumentEntry>();
  private readonly evictions = new Set<Promise<void>>();
  private readonly idleCloseMs: number;
  private readonly maxLiveDocuments: number;
  private useCounter = 0;

  constructor(private readonly options: WorkspaceDocumentsOptions) {
    this.idleCloseMs = options.idleCloseMs ?? WORKSPACE_DOCUMENT_IDLE_CLOSE_MS;
    this.maxLiveDocuments = Math.max(1, options.maxLiveDocuments ?? WORKSPACE_DOCUMENT_MAX_LIVE);
  }

  document(rawPath: string): Promise<WorkspaceCollaborativeDocument> {
    if (this.closeRequest) {
      return Promise.reject(new Error("The workspace document registry is closed."));
    }

    let path = normalizeWorkspaceDocumentPath(rawPath);
    let existing = this.documents.get(path);
    if (existing?.request) {
      this.touch(path, existing);
      return existing.request;
    }

    let entry: DocumentEntry = {
      document: null,
      idleTimer: null,
      lastUsed: ++this.useCounter,
      refs: 0,
      request: null,
    };
    let request = this.open(path, entry);
    entry.request = request;
    this.documents.set(path, entry);
    request.then(
      (document) => {
        if (this.documents.get(path) !== entry) return;
        entry.document = document;
        this.touch(path, entry);
        this.enforceCapacity();
      },
      () => {
        if (this.documents.get(path) === entry) this.documents.delete(path);
      },
    );
    return request;
  }

  /** Number of resident (opened or opening) documents. */
  liveDocumentCount() {
    return this.documents.size;
  }

  close() {
    return (this.closeRequest ??= this.closeDocuments());
  }

  private async open(path: string, entry: DocumentEntry) {
    let state = await openMarkdownCollabDocument(
      { documentSource: this.options.documentSource, identity: this.options.identity },
      path,
    );
    return new ManagedCollaborativeDocument({
      changes: this.options.changes,
      documentSource: this.options.documentSource,
      identity: this.options.identity,
      path,
      retain: () => this.retain(path, entry),
      state,
    });
  }

  private retain(path: string, entry: DocumentEntry) {
    if (this.documents.get(path) !== entry || this.closeRequest) return () => {};
    entry.refs += 1;
    this.clearIdleTimer(entry);
    entry.lastUsed = ++this.useCounter;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (this.documents.get(path) !== entry || this.closeRequest) return;
      entry.lastUsed = ++this.useCounter;
      if (entry.refs == 0) {
        this.scheduleIdleClose(path, entry);
        this.enforceCapacity();
      }
    };
  }

  private touch(path: string, entry: DocumentEntry) {
    entry.lastUsed = ++this.useCounter;
    if (entry.refs == 0 && entry.document) this.scheduleIdleClose(path, entry);
  }

  private scheduleIdleClose(path: string, entry: DocumentEntry) {
    this.clearIdleTimer(entry);
    if (this.closeRequest) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (this.documents.get(path) !== entry || entry.refs > 0) return;
      if (!this.evict(path, entry)) this.scheduleIdleClose(path, entry);
    }, this.idleCloseMs);
  }

  private clearIdleTimer(entry: DocumentEntry) {
    if (entry.idleTimer == null) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private enforceCapacity() {
    if (this.closeRequest) return;
    let excess = this.documents.size - this.maxLiveDocuments;
    if (excess <= 0) return;
    let candidates = [...this.documents]
      .filter(([, entry]) => entry.refs == 0 && entry.document && isEvictable(entry.document))
      .toSorted(([, left], [, right]) => left.lastUsed - right.lastUsed);
    for (let [path, entry] of candidates) {
      if (excess <= 0) break;
      if (this.evict(path, entry)) excess -= 1;
    }
  }

  private evict(path: string, entry: DocumentEntry) {
    let document = entry.document;
    if (!document || entry.refs > 0 || !isEvictable(document)) return false;
    this.clearIdleTimer(entry);
    this.documents.delete(path);
    let eviction = document.close().catch(() => {
      // close() flushes first; a failed flush leaves state in the browser store.
    });
    this.evictions.add(eviction);
    void eviction.finally(() => this.evictions.delete(eviction));
    return true;
  }

  private async closeDocuments() {
    let entries = [...this.documents.values()];
    for (let entry of entries) this.clearIdleTimer(entry);
    let opened = await Promise.allSettled(entries.flatMap((entry) => entry.request ?? []));
    let closed = await Promise.allSettled(
      opened.flatMap((result) => (result.status == "fulfilled" ? [result.value.close()] : [])),
    );
    this.documents.clear();
    await Promise.allSettled(this.evictions);

    let errors = closed.flatMap((result) => (result.status == "rejected" ? [result.reason] : []));
    if (errors.length == 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Workspace documents failed to close.");
  }
}

function isEvictable(document: ManagedCollaborativeDocument) {
  return document.snapshot().persistenceStatus == "saved";
}
