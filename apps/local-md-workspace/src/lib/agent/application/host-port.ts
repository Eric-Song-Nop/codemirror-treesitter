import type {
  WorkspaceAgentChangeSummary,
  WorkspaceAgentContext,
  WorkspaceAgentListMarkdownInput,
  WorkspaceAgentListMarkdownResult,
  WorkspaceAgentReadFileInput,
  WorkspaceAgentReadFileResult,
  WorkspaceAgentSearchMarkdownInput,
  WorkspaceAgentSearchResult,
  WorkspaceAgentWriteFileInput,
  WorkspaceAgentWriteFileResult,
} from "../domain/contracts.ts";

export type WorkspaceAgentWriteApprovalRequest = {
  change: WorkspaceAgentChangeSummary;
  /** Canonical workspace path of the target file. */
  path: string;
  signal?: AbortSignal;
  toolCallId?: string;
};

export type WorkspaceAgentRevertResult =
  | { status: "reverted" }
  | { message: string; status: "conflict" | "failed" };

/** An applied Agent write, kept in page memory so the user can revert it. */
export type WorkspaceAgentAppliedEdit = {
  change: WorkspaceAgentChangeSummary;
  path: string;
  /** Reapplies the pre-edit content through the shared Loro document. */
  revert(): Promise<WorkspaceAgentRevertResult>;
  toolCallId?: string;
};

/**
 * Tool-execution-layer hooks for writes. `approve` runs after the edit is
 * validated and before it is committed; a `false` result rejects the write.
 */
export type WorkspaceAgentWriteControl = {
  approve?(request: WorkspaceAgentWriteApprovalRequest): Promise<boolean>;
  onApplied?(edit: WorkspaceAgentAppliedEdit): void;
};

export interface WorkspaceAgentHost {
  getContext(): WorkspaceAgentContext;
  listMarkdown(
    input?: WorkspaceAgentListMarkdownInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceAgentListMarkdownResult>;
  readFile(
    input: WorkspaceAgentReadFileInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceAgentReadFileResult>;
  searchMarkdown(
    input: WorkspaceAgentSearchMarkdownInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceAgentSearchResult>;
  writeFile(
    input: WorkspaceAgentWriteFileInput,
    signal?: AbortSignal,
    control?: WorkspaceAgentWriteControl,
  ): Promise<WorkspaceAgentWriteFileResult>;
}
