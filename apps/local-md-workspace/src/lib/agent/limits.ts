export type WorkspaceAgentLimits = {
  catalog: {
    maxDepth: number;
    maxDirectories: number;
    maxFiles: number;
  };
  list: {
    defaultPageSize: number;
    maxPageSize: number;
  };
  read: {
    maxBytes: number;
    maxLines: number;
  };
  search: {
    localConcurrency: number;
    maxBytes: number;
    maxFileBytes: number;
    maxFiles: number;
    maxMatches: number;
    maxSnippetCharacters: number;
    minQueryCharacters: number;
    remoteConcurrency: number;
  };
  write: {
    maxOutputBytes: number;
    maxReplacements: number;
  };
};

export type WorkspaceAgentLimitOverrides = {
  catalog?: Partial<WorkspaceAgentLimits["catalog"]>;
  list?: Partial<WorkspaceAgentLimits["list"]>;
  read?: Partial<WorkspaceAgentLimits["read"]>;
  search?: Partial<WorkspaceAgentLimits["search"]>;
  write?: Partial<WorkspaceAgentLimits["write"]>;
};

export const DEFAULT_WORKSPACE_AGENT_LIMITS: Readonly<WorkspaceAgentLimits> = Object.freeze({
  catalog: Object.freeze({
    maxDepth: 32,
    maxDirectories: 500,
    maxFiles: 2_000,
  }),
  list: Object.freeze({
    defaultPageSize: 50,
    maxPageSize: 200,
  }),
  read: Object.freeze({
    maxBytes: 64 * 1_024,
    maxLines: 400,
  }),
  search: Object.freeze({
    localConcurrency: 4,
    maxBytes: 5 * 1_024 * 1_024,
    maxFileBytes: 512 * 1_024,
    maxFiles: 200,
    maxMatches: 100,
    maxSnippetCharacters: 240,
    minQueryCharacters: 2,
    remoteConcurrency: 2,
  }),
  write: Object.freeze({
    maxOutputBytes: 256 * 1_024,
    maxReplacements: 32,
  }),
});

export function resolveWorkspaceAgentLimits(
  overrides: WorkspaceAgentLimitOverrides = {},
): WorkspaceAgentLimits {
  let limits = {
    catalog: { ...DEFAULT_WORKSPACE_AGENT_LIMITS.catalog, ...overrides.catalog },
    list: { ...DEFAULT_WORKSPACE_AGENT_LIMITS.list, ...overrides.list },
    read: { ...DEFAULT_WORKSPACE_AGENT_LIMITS.read, ...overrides.read },
    search: { ...DEFAULT_WORKSPACE_AGENT_LIMITS.search, ...overrides.search },
    write: { ...DEFAULT_WORKSPACE_AGENT_LIMITS.write, ...overrides.write },
  };

  for (let [groupName, group] of Object.entries(limits)) {
    for (let [limitName, value] of Object.entries(group)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${groupName}.${limitName} must be a positive safe integer.`);
      }
    }
  }

  if (limits.list.defaultPageSize > limits.list.maxPageSize) {
    limits.list.defaultPageSize = limits.list.maxPageSize;
  }
  if (limits.search.maxFiles > limits.catalog.maxFiles) {
    limits.search.maxFiles = limits.catalog.maxFiles;
  }
  return limits;
}
