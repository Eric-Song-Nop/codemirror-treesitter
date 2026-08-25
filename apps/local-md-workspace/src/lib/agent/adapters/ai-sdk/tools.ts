import { tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import type {
  WorkspaceAgentListMarkdownInput,
  WorkspaceAgentReadFileInput,
  WorkspaceAgentSearchMarkdownInput,
  WorkspaceAgentWriteFileInput,
} from "../../domain/contracts.ts";
import type {
  WorkspaceAgentToolExecution,
  WorkspaceAgentToolSession,
} from "../../application/tool-session.ts";

const listMarkdownSchema = z.object({
  cursor: z.string().optional(),
  directory: z.string().optional(),
  limit: z.number().int().positive().optional(),
}) satisfies z.ZodType<WorkspaceAgentListMarkdownInput>;

const readFileSchema = z.object({
  lineCount: z.number().int().positive().optional(),
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
}) satisfies z.ZodType<WorkspaceAgentReadFileInput>;

const searchMarkdownSchema = z.object({
  caseSensitive: z.boolean().optional(),
  directory: z.string().optional(),
  query: z.string().min(1),
}) satisfies z.ZodType<WorkspaceAgentSearchMarkdownInput>;

const writeFileSchema = z.object({
  edits: z
    .array(
      z.object({
        expectedText: z.string(),
        from: z.number().int().nonnegative(),
        insert: z.string(),
        to: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(32),
  path: z.string().min(1),
}) satisfies z.ZodType<WorkspaceAgentWriteFileInput>;

export function createWorkspaceAgentTools(session: WorkspaceAgentToolSession) {
  return {
    get_workspace_context: tool({
      description: "Get the bound workspace identity and available capabilities.",
      inputSchema: z.object({}),
      execute: (_input, options) => session.getContext(toolExecution(options)),
    }),
    list_markdown_files: tool({
      description: "List Markdown files in a workspace directory with stable cursor pagination.",
      inputSchema: listMarkdownSchema,
      execute: (input, options) => session.listMarkdown(input, toolExecution(options)),
    }),
    read_file: tool({
      description:
        "Read a bounded line window from a Markdown file, including absolute UTF-16 offsets for exact edits.",
      inputSchema: readFileSchema,
      execute: (input, options) => session.readFile(input, toolExecution(options)),
    }),
    search_markdown: tool({
      description:
        "Search Markdown files for a literal substring using bounded workspace scanning.",
      inputSchema: searchMarkdownSchema,
      execute: (input, options) => session.searchMarkdown(input, toolExecution(options)),
    }),
    write_file: tool({
      description:
        "Apply exact offset-based edits to any Markdown file in the current workspace and flush its filesystem projection.",
      inputSchema: writeFileSchema,
      execute: (input, options) => session.writeFile(input, toolExecution(options)),
    }),
  };
}

function toolExecution(options: ToolExecutionOptions<unknown>): WorkspaceAgentToolExecution {
  return {
    callId: options.toolCallId,
    signal: options.abortSignal,
  };
}
