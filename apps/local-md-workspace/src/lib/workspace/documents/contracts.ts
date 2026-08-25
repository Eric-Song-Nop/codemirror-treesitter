import type { LiveMdConfig } from "@codemirror-treesitter/live-md";
import type { LoroDoc } from "loro-crdt";
import type {
  CollabDocumentMaterialization,
  CollabDocumentState,
  CollabExternalEditResolution,
} from "@/lib/collaboration/markdown-document";
import type { SourceRevision } from "@/lib/workspace/storage/types";

export type ExactTextEdit = Readonly<{
  expectedText: string;
  from: number;
  insert: string;
  to: number;
}>;

export type EditConflictReason = "expected-text-mismatch" | "invalid-range" | "overlapping-edits";

export type EditResult =
  | Readonly<{
      appliedEdits: number;
      generation: number;
      status: "applied";
      value: string;
    }>
  | Readonly<{
      editIndex: number;
      reason: EditConflictReason;
      status: "conflict";
      value: string;
    }>;

export type DocumentPersistenceStatus = "blocked" | "error" | "pending" | "saved" | "saving";

export type CollaborativeDocumentSnapshot = Readonly<{
  generation: number;
  path: string;
  persistenceError?: unknown;
  persistenceStatus: DocumentPersistenceStatus;
  sourceKind: CollabDocumentState["source"]["kind"];
  value: string;
}>;

export type DocumentListenerEvent =
  | Readonly<{
      kind: "closed";
      snapshot: CollaborativeDocumentSnapshot;
    }>
  | Readonly<{
      kind: "changed";
      snapshot: CollaborativeDocumentSnapshot;
    }>
  | Readonly<{
      externalEdit?: CollabExternalEditResolution;
      kind: "materialized";
      materialization: CollabDocumentMaterialization;
      snapshot: CollaborativeDocumentSnapshot;
      sourceUpdate: Uint8Array | null;
    }>
  | Readonly<{
      error: unknown;
      kind: "persistence-error";
      snapshot: CollaborativeDocumentSnapshot;
    }>;

export type DocumentListener = (event: DocumentListenerEvent) => void;

export type UseExternalChangeResult =
  | Readonly<{ status: "applied"; update: Uint8Array }>
  | Readonly<{ status: "incoming-changed" }>;

export interface CollaborativeDocument {
  edit(edits: readonly ExactTextEdit[]): EditResult;
  flush(): Promise<void>;
  read(): string;
  snapshot(): CollaborativeDocumentSnapshot;
  subscribe(listener: DocumentListener): () => void;
}

export interface WorkspaceCollaborativeDocument extends CollaborativeDocument {
  readonly collabState: CollabDocumentState;
  readonly docId: string;
  readonly liveMdConfig: LiveMdConfig;
  readonly loroDoc: LoroDoc;
  readonly path: string;
  applyRemoteUpdate(update: Uint8Array): void;
  importExternalChange(): Promise<void>;
  recreateSource(): Promise<void>;
  useExternalChange(expectedRevision: SourceRevision): Promise<UseExternalChangeResult>;
  writeCopy(path: string): Promise<void>;
}

export interface WorkspaceDocuments {
  close(): Promise<void>;
  document(path: string): Promise<WorkspaceCollaborativeDocument>;
}
