import type { WorkspaceIdentity } from "../../workspace/runtime/types.ts";
import type { WorkspaceStorageErrorCode } from "../../workspace/storage/types.ts";
import type { EditConflictReason } from "../../workspace/documents/contracts.ts";

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

export type WorkspaceAgentReadFileInput = {
  lineCount?: number;
  path: string;
  startLine?: number;
};

export type WorkspaceAgentReadFileResult =
  | {
      endLine: number;
      endOffset: number;
      nextStartLine?: number;
      path: string;
      startLine: number;
      startOffset: number;
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
  expectedText: string;
  from: number;
  insert: string;
  to: number;
};

export type WorkspaceAgentWriteFileInput = {
  edits: WorkspaceAgentTextEdit[];
  path: string;
};

export type WorkspaceAgentWriteFailureReason =
  | EditConflictReason
  | "aborted"
  | "invalid-edit-count"
  | "not-markdown"
  | "outside-workspace"
  | "output-too-large"
  | "unavailable";

export type WorkspaceAgentWriteFileResult =
  | {
      appliedEdits: number;
      generation: number;
      outputBytes: number;
      path: string;
      persistence: { status: "saved" } | { message: string; status: "blocked" | "error" };
      status: "applied";
    }
  | {
      editIndex?: number;
      message: string;
      path: string;
      reason: WorkspaceAgentWriteFailureReason;
      status: "not-applied";
    };

export type WorkspaceAgentContext = {
  capabilities: {
    listMarkdown: true;
    readFile: true;
    searchMarkdown: true;
    writeFile: true;
  };
  workspace: Pick<WorkspaceIdentity, "id" | "kind" | "name">;
};
