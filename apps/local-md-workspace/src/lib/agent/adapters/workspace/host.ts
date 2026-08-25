import type {
  WorkspaceAgentContext,
  WorkspaceAgentListMarkdownInput,
  WorkspaceAgentListMarkdownResult,
  WorkspaceAgentReadFileInput,
  WorkspaceAgentSearchMarkdownInput,
  WorkspaceAgentWriteFileInput,
} from "../../domain/contracts.ts";
import type { WorkspaceAgentHost } from "../../application/host-port.ts";
import { writeWorkspaceAgentFile } from "./file-edits.ts";
import {
  resolveWorkspaceAgentLimits,
  type WorkspaceAgentLimitOverrides,
  type WorkspaceAgentLimits,
} from "../../domain/limits.ts";
import {
  collectWorkspaceMarkdownCatalog,
  compareWorkspaceAgentPaths,
  normalizeWorkspaceAgentDirectory,
} from "../../application/workspace-catalog.ts";
import {
  readWorkspaceFile,
  searchWorkspaceMarkdown,
  type WorkspaceAgentReadRuntime,
} from "../../application/workspace-search.ts";

export function createWorkspaceAgentHost(input: {
  limits?: WorkspaceAgentLimitOverrides;
  runtime: WorkspaceAgentReadRuntime;
}): WorkspaceAgentHost {
  return new DefaultWorkspaceAgentHost(input.runtime, resolveWorkspaceAgentLimits(input.limits));
}

class DefaultWorkspaceAgentHost implements WorkspaceAgentHost {
  constructor(
    private readonly runtime: WorkspaceAgentReadRuntime,
    private readonly limits: WorkspaceAgentLimits,
  ) {}

  getContext(): WorkspaceAgentContext {
    return {
      capabilities: {
        listMarkdown: true,
        readFile: true,
        searchMarkdown: true,
        writeFile: true,
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
      ? catalog.files.findIndex((file) => compareWorkspaceAgentPaths(file.path, cursor) > 0)
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

  readFile(input: WorkspaceAgentReadFileInput, signal?: AbortSignal) {
    return readWorkspaceFile({
      limits: this.limits,
      request: input,
      runtime: this.runtime,
      signal,
    });
  }

  searchMarkdown(input: WorkspaceAgentSearchMarkdownInput, signal?: AbortSignal) {
    return searchWorkspaceMarkdown({
      limits: this.limits,
      request: input,
      runtime: this.runtime,
      signal,
    });
  }

  writeFile(input: WorkspaceAgentWriteFileInput, signal?: AbortSignal) {
    return writeWorkspaceAgentFile({
      limits: this.limits,
      request: input,
      runtime: this.runtime,
      signal,
    });
  }
}

function positiveInteger(value: number | undefined, fallback: number) {
  return value == null || !Number.isSafeInteger(value) || value < 1 ? fallback : value;
}
