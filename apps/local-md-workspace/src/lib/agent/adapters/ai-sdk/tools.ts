import { tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import type {
  WorkspaceAgentApplyCurrentDocumentEditsInput,
  WorkspaceAgentListMarkdownInput,
  WorkspaceAgentReadMarkdownInput,
  WorkspaceAgentSearchMarkdownInput,
} from "../../domain/contracts.ts";
import type { WorkspaceAgentActiveDocumentVersion } from "../../domain/active-document.ts";
import type {
  WorkspaceAgentToolExecution,
  WorkspaceAgentToolSession,
} from "../../application/tool-session.ts";

const listMarkdownSchema = z.object({
  cursor: z.string().optional(),
  directory: z.string().optional(),
  limit: z.number().int().positive().optional(),
}) satisfies z.ZodType<WorkspaceAgentListMarkdownInput>;

const readMarkdownSchema = z.object({
  lineCount: z.number().int().positive().optional(),
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
}) satisfies z.ZodType<WorkspaceAgentReadMarkdownInput>;

const searchMarkdownSchema = z.object({
  caseSensitive: z.boolean().optional(),
  directory: z.string().optional(),
  query: z.string().min(1),
}) satisfies z.ZodType<WorkspaceAgentSearchMarkdownInput>;

const activeDocumentVersionSchema = z.object({
  contentHash: z.string().min(1),
  documentGeneration: z.number().int().nonnegative(),
  documentId: z.string().min(1),
  editVersion: z.number().int().nonnegative(),
  path: z.string().min(1),
  targetGeneration: z.number().int().nonnegative(),
  version: z.literal(1),
  workspaceId: z.string().min(1),
}) satisfies z.ZodType<WorkspaceAgentActiveDocumentVersion>;

const applyCurrentDocumentEditsSchema = z.object({
  edits: z
    .array(
      z.object({
        newText: z.string(),
        oldText: z.string(),
      }),
    )
    .min(1)
    .max(32),
  version: activeDocumentVersionSchema,
}) satisfies z.ZodType<WorkspaceAgentApplyCurrentDocumentEditsInput>;

export function createWorkspaceAgentTools(session: WorkspaceAgentToolSession) {
  return {
    get_workspace_context: tool({
      description: "Get the bound workspace identity, active document, and available capabilities.",
      inputSchema: z.object({}),
      execute: (_input, options) => session.getContext(toolExecution(options)),
    }),
    list_markdown_files: tool({
      description: "List Markdown files in a workspace directory with stable cursor pagination.",
      inputSchema: listMarkdownSchema,
      execute: (input, options) => session.listMarkdown(input, toolExecution(options)),
    }),
    read_markdown: tool({
      description:
        "Read a bounded line window from a Markdown file. Active-document reads include the version token required for edits.",
      inputSchema: readMarkdownSchema,
      execute: (input, options) => session.readMarkdown(input, toolExecution(options)),
    }),
    search_markdown: tool({
      description:
        "Search Markdown files for a literal substring using bounded workspace scanning.",
      inputSchema: searchMarkdownSchema,
      execute: (input, options) => session.searchMarkdown(input, toolExecution(options)),
    }),
    apply_current_document_edits: tool({
      description:
        "Apply exact unique replacements to the currently active document using a version token from read_markdown.",
      inputSchema: applyCurrentDocumentEditsSchema,
      execute: (input, options) => session.applyCurrentDocumentEdits(input, toolExecution(options)),
    }),
  };
}

function toolExecution(options: ToolExecutionOptions<unknown>): WorkspaceAgentToolExecution {
  return {
    callId: options.toolCallId,
    signal: options.abortSignal,
  };
}
