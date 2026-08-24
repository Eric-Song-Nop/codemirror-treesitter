import type { SourceRevision, WorkspaceStorageErrorCode } from "../workspace/storage/types.ts";
import type { WorkspaceIdentity } from "../workspace/runtime/types.ts";

export type WorkspaceAgentActiveDocument = {
  dirty: boolean;
  path: string;
  value: string;
  version?: number | string;
};

export type WorkspaceAgentIssue = {
  code?: WorkspaceStorageErrorCode;
  message: string;
  path: string;
  retryable?: boolean;
};

export type WorkspaceAgentCatalogTruncationReason = "max-depth" | "max-directories" | "max-files";

export type WorkspaceAgentCatalogStatus = "complete" | "not-found" | "partial" | "truncated";

export type WorkspaceAgentMarkdownFile = {
  name: string;
  path: string;
};

export type WorkspaceAgentCatalogResult = {
  directory: string;
  files: WorkspaceAgentMarkdownFile[];
  issues: WorkspaceAgentIssue[];
  scannedDirectories: number;
  status: WorkspaceAgentCatalogStatus;
  truncationReason?: WorkspaceAgentCatalogTruncationReason;
};

export type WorkspaceAgentListMarkdownInput = {
  cursor?: string;
  directory?: string;
  limit?: number;
};

export type WorkspaceAgentListMarkdownResult = WorkspaceAgentCatalogResult & {
  nextCursor?: string;
};

export type WorkspaceAgentReadMarkdownInput = {
  lineCount?: number;
  path: string;
  startLine?: number;
};

export type WorkspaceAgentDocumentSource =
  | {
      dirty: boolean;
      kind: "active-document";
      version?: number | string;
    }
  | {
      capture: "bound" | "observed";
      contentHash: string;
      kind: "workspace-source";
      revision: SourceRevision;
    };

export type WorkspaceAgentReadMarkdownResult =
  | {
      endLine: number;
      nextStartLine?: number;
      path: string;
      source: WorkspaceAgentDocumentSource;
      startLine: number;
      status: "found";
      text: string;
      totalBytes: number;
      totalLines: number;
      truncated: boolean;
    }
  | {
      path: string;
      reason: "not-markdown" | "outside-workspace";
      status: "not-found";
    }
  | {
      path: string;
      status: "missing";
    }
  | {
      issue: WorkspaceAgentIssue;
      path: string;
      status: "unavailable";
    };

export type WorkspaceAgentSearchMarkdownInput = {
  caseSensitive?: boolean;
  directory?: string;
  query: string;
};

export type WorkspaceAgentSearchMatch = {
  column: number;
  line: number;
  path: string;
  preview: string;
};

export type WorkspaceAgentSearchTruncationReason =
  | WorkspaceAgentCatalogTruncationReason
  | "max-bytes"
  | "max-file-bytes"
  | "max-matches";

export type WorkspaceAgentSearchResult = {
  directory: string;
  issues: WorkspaceAgentIssue[];
  matches: WorkspaceAgentSearchMatch[];
  query: string;
  readBytes: number;
  scannedFiles: number;
  skippedLargeFiles: number;
  status: WorkspaceAgentCatalogStatus;
  truncationReason?: WorkspaceAgentSearchTruncationReason;
};

export type WorkspaceAgentContext = {
  activeDocument: null | {
    dirty: boolean;
    path: string;
    version?: number | string;
  };
  capabilities: {
    listMarkdown: true;
    readMarkdown: true;
    searchMarkdown: true;
  };
  workspace: Pick<WorkspaceIdentity, "id" | "kind" | "name">;
};
