import type {
  WorkspaceAgentActiveEditorCapability,
  WorkspaceAgentApplyCurrentDocumentEditsInput,
  WorkspaceAgentApplyCurrentDocumentEditsResult,
  WorkspaceAgentContext,
  WorkspaceAgentListMarkdownInput,
  WorkspaceAgentListMarkdownResult,
  WorkspaceAgentReadMarkdownInput,
  WorkspaceAgentReadMarkdownResult,
  WorkspaceAgentSearchMarkdownInput,
  WorkspaceAgentSearchResult,
} from "./contracts.ts";
import {
  captureWorkspaceAgentActiveEditor,
  workspaceAgentActiveDocumentVersion,
} from "./active-document.ts";
import { applyWorkspaceAgentCurrentDocumentEdits } from "./current-document-edits.ts";
import {
  resolveWorkspaceAgentLimits,
  type WorkspaceAgentLimitOverrides,
  type WorkspaceAgentLimits,
} from "./limits.ts";
import {
  collectWorkspaceMarkdownCatalog,
  normalizeWorkspaceAgentDirectory,
} from "./workspace-catalog.ts";
import {
  readWorkspaceMarkdown,
  searchWorkspaceMarkdown,
  type WorkspaceAgentReadRuntime,
} from "./workspace-search.ts";

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

export function createWorkspaceAgentHost(input: {
  activeEditor?: WorkspaceAgentActiveEditorCapability;
  limits?: WorkspaceAgentLimitOverrides;
  runtime: WorkspaceAgentReadRuntime;
}): WorkspaceAgentHost {
  return new DefaultWorkspaceAgentHost(
    input.runtime,
    resolveWorkspaceAgentLimits(input.limits),
    input.activeEditor,
  );
}

class DefaultWorkspaceAgentHost implements WorkspaceAgentHost {
  constructor(
    private readonly runtime: WorkspaceAgentReadRuntime,
    private readonly limits: WorkspaceAgentLimits,
    private readonly activeEditor: WorkspaceAgentActiveEditorCapability | undefined,
  ) {}

  getContext(): WorkspaceAgentContext {
    let active = this.captureActiveDocument();
    return {
      activeDocument: active
        ? {
            dirty: active.dirty,
            path: active.path,
            version: workspaceAgentActiveDocumentVersion(active),
          }
        : null,
      capabilities: {
        applyCurrentDocumentEdits: Boolean(this.activeEditor),
        listMarkdown: true,
        readMarkdown: true,
        searchMarkdown: true,
      },
      workspace: {
        id: this.runtime.identity.id,
        kind: this.runtime.identity.kind,
        name: this.runtime.identity.name,
      },
    };
  }

  async listMarkdown(
    input: WorkspaceAgentListMarkdownInput = {},
    signal?: AbortSignal,
  ): Promise<WorkspaceAgentListMarkdownResult> {
    let directory = normalizeWorkspaceAgentDirectory(input.directory);
    if (directory == null) {
      return {
        directory: "",
        files: [],
        issues: [],
        scannedDirectories: 0,
        status: "not-found",
      };
    }
    let catalog = await collectWorkspaceMarkdownCatalog({
      directory,
      limits: this.limits.catalog,
      signal,
      tree: this.runtime.tree,
    });
    let requestedLimit = positiveInteger(input.limit, this.limits.list.defaultPageSize);
    let limit = Math.min(requestedLimit, this.limits.list.maxPageSize);
    let cursor = input.cursor ?? "";
    let start = cursor
      ? catalog.files.findIndex((file) => compareCursor(file.path, cursor) > 0)
      : 0;
    if (start < 0) start = catalog.files.length;
    let files = catalog.files.slice(start, start + limit);
    let hasMore = start + files.length < catalog.files.length;
    return {
      ...catalog,
      files,
      nextCursor: hasMore ? files.at(-1)?.path : undefined,
    };
  }

  readMarkdown(input: WorkspaceAgentReadMarkdownInput, signal?: AbortSignal) {
    return readWorkspaceMarkdown({
      activeDocument: this.captureActiveDocument(),
      limits: this.limits,
      request: input,
      runtime: this.runtime,
      signal,
    });
  }

  searchMarkdown(input: WorkspaceAgentSearchMarkdownInput, signal?: AbortSignal) {
    return searchWorkspaceMarkdown({
      activeDocument: this.captureActiveDocument(),
      limits: this.limits,
      request: input,
      runtime: this.runtime,
      signal,
    });
  }

  applyCurrentDocumentEdits(
    input: WorkspaceAgentApplyCurrentDocumentEditsInput,
    signal?: AbortSignal,
  ) {
    return applyWorkspaceAgentCurrentDocumentEdits({
      activeEditor: this.activeEditor,
      limits: this.limits.write,
      request: input,
      signal,
      workspaceId: this.runtime.identity.id,
    });
  }

  private captureActiveDocument() {
    let capture = captureWorkspaceAgentActiveEditor(this.activeEditor);
    return capture?.document.workspaceId == this.runtime.identity.id ? capture.document : null;
  }
}

function positiveInteger(value: number | undefined, fallback: number) {
  return value == null || !Number.isSafeInteger(value) || value < 1 ? fallback : value;
}

function compareCursor(path: string, cursor: string) {
  return path.localeCompare(cursor, undefined, { numeric: true, sensitivity: "base" });
}
