import type { WorkspaceIdentity } from "../../workspace/runtime/types.ts";
import type { SourceRevision, WorkspaceStorageErrorCode } from "../../workspace/storage/types.ts";
import type {
  WorkspaceAgentActiveDocumentVersion,
  WorkspaceAgentVersionConflict,
} from "./active-document.ts";

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
      version: WorkspaceAgentActiveDocumentVersion;
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

export type WorkspaceAgentTextEdit = {
  newText: string;
  oldText: string;
};

export type WorkspaceAgentApplyCurrentDocumentEditsInput = {
  edits: WorkspaceAgentTextEdit[];
  version: WorkspaceAgentActiveDocumentVersion;
};

export type WorkspaceAgentEditFailureReason =
  | "aborted"
  | "active-document-unavailable"
  | "ambiguous-old-text"
  | "invalid-edit-count"
  | "missing-old-text"
  | "output-too-large"
  | "overlapping-edits"
  | "stale-version";

export type WorkspaceAgentApplyCurrentDocumentEditsResult =
  | {
      appliedEdits: number;
      outputBytes: number;
      path: string;
      status: "applied";
    }
  | {
      conflicts?: WorkspaceAgentVersionConflict[];
      editIndex?: number;
      message: string;
      path: string;
      reason: WorkspaceAgentEditFailureReason;
      status: "not-applied";
    };

export type WorkspaceAgentContext = {
  activeDocument: null | {
    dirty: boolean;
    path: string;
    version: WorkspaceAgentActiveDocumentVersion;
  };
  capabilities: {
    applyCurrentDocumentEdits: boolean;
    listMarkdown: true;
    readMarkdown: true;
    searchMarkdown: true;
  };
  workspace: Pick<WorkspaceIdentity, "id" | "kind" | "name">;
};
