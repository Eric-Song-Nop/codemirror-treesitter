import type {
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
  ): Promise<WorkspaceAgentWriteFileResult>;
}
