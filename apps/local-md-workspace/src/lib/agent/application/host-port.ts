import type {
  WorkspaceAgentApplyCurrentDocumentEditsInput,
  WorkspaceAgentApplyCurrentDocumentEditsResult,
  WorkspaceAgentContext,
  WorkspaceAgentListMarkdownInput,
  WorkspaceAgentListMarkdownResult,
  WorkspaceAgentReadMarkdownInput,
  WorkspaceAgentReadMarkdownResult,
  WorkspaceAgentSearchMarkdownInput,
  WorkspaceAgentSearchResult,
} from "../domain/contracts.ts";

export interface WorkspaceAgentHost {
  applyCurrentDocumentEdits(
    input: WorkspaceAgentApplyCurrentDocumentEditsInput,
    signal?: AbortSignal,
  ): WorkspaceAgentApplyCurrentDocumentEditsResult;
  getContext(): WorkspaceAgentContext;
  listMarkdown(
    input?: WorkspaceAgentListMarkdownInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceAgentListMarkdownResult>;
  readMarkdown(
    input: WorkspaceAgentReadMarkdownInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceAgentReadMarkdownResult>;
  searchMarkdown(
    input: WorkspaceAgentSearchMarkdownInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceAgentSearchResult>;
}
