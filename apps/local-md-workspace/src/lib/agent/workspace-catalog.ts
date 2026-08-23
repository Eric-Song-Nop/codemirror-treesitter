import type { MarkdownDirectoryNode, MarkdownTreeNode } from "../workspace/tree.ts";
import type { WorkspaceTreePort } from "../workspace/runtime/types.ts";
import { awaitWorkspaceAgentOperation, throwIfWorkspaceAgentAborted } from "./abort.ts";
import type {
  WorkspaceAgentCatalogResult,
  WorkspaceAgentCatalogTruncationReason,
  WorkspaceAgentIssue,
  WorkspaceAgentMarkdownFile,
} from "./contracts.ts";
import type { WorkspaceAgentLimits } from "./limits.ts";

type CatalogLimits = WorkspaceAgentLimits["catalog"];

export async function collectWorkspaceMarkdownCatalog(input: {
  directory?: string;
  limits: CatalogLimits;
  signal?: AbortSignal;
  tree: WorkspaceTreePort;
}): Promise<WorkspaceAgentCatalogResult> {
  let directory = normalizeWorkspaceAgentDirectory(input.directory);
  if (directory == null) {
    return emptyCatalog("", "not-found");
  }

  let issues: WorkspaceAgentIssue[] = [];
  let scannedDirectories = 0;
  let truncationReason: WorkspaceAgentCatalogTruncationReason | undefined;
  let loadDirectory = async (
    path: string,
    name: string,
    root = false,
  ): Promise<MarkdownDirectoryNode | null> => {
    throwIfWorkspaceAgentAborted(input.signal);
    if (scannedDirectories >= input.limits.maxDirectories) {
      truncationReason ??= "max-directories";
      return null;
    }
    scannedDirectories++;
    try {
      return await awaitWorkspaceAgentOperation(
        root ? input.tree.readTree() : input.tree.readDirectory(path, name),
        input.signal,
      );
    } catch (error) {
      throwIfWorkspaceAgentAborted(input.signal);
      issues.push(workspaceAgentIssue(path, error));
      return null;
    }
  };

  let root = await loadDirectory("", "", true);
  if (!root) {
    return catalogResult({
      directory,
      files: [],
      issues,
      scannedDirectories,
      truncationReason,
    });
  }

  let scopedRoot = root;
  let scopedPath = "";
  for (let segment of splitWorkspaceAgentPath(directory)) {
    scopedPath = scopedPath ? `${scopedPath}/${segment}` : segment;
    let child = directChildren(scopedRoot).find(
      (node): node is MarkdownDirectoryNode => node.kind == "directory" && node.path == scopedPath,
    );
    if (!child) {
      return {
        directory,
        files: [],
        issues,
        scannedDirectories,
        status: "not-found",
      };
    }
    let loaded = await loadDirectory(child.path, child.name);
    if (!loaded) {
      return catalogResult({
        directory,
        files: [],
        issues,
        scannedDirectories,
        truncationReason,
      });
    }
    scopedRoot = loaded;
  }

  let files: WorkspaceAgentMarkdownFile[] = [];
  let visited = new Set<string>([scopedRoot.path]);
  let queue: Array<{ depth: number; directory: MarkdownDirectoryNode }> = [
    { depth: 0, directory: scopedRoot },
  ];

  while (queue.length && !truncationReason) {
    throwIfWorkspaceAgentAborted(input.signal);
    let current = queue.shift()!;
    for (let node of directChildren(current.directory)) {
      if (node.kind == "file") {
        if (!isWorkspaceAgentMarkdownPath(node.path)) continue;
        if (files.length >= input.limits.maxFiles) {
          truncationReason = "max-files";
          break;
        }
        files.push({ name: node.name, path: node.path });
        continue;
      }

      if (visited.has(node.path)) continue;
      visited.add(node.path);
      if (current.depth >= input.limits.maxDepth) {
        truncationReason ??= "max-depth";
        continue;
      }
      let loaded = await loadDirectory(node.path, node.name);
      if (loaded) queue.push({ depth: current.depth + 1, directory: loaded });
    }
  }

  files.sort((a, b) => compareWorkspaceAgentPaths(a.path, b.path));
  return catalogResult({
    directory,
    files,
    issues,
    scannedDirectories,
    truncationReason,
  });
}

export async function resolveWorkspaceMarkdownFile(input: {
  limits: CatalogLimits;
  path: string;
  signal?: AbortSignal;
  tree: WorkspaceTreePort;
}): Promise<{
  file: WorkspaceAgentMarkdownFile | null;
  issue?: WorkspaceAgentIssue;
  reason?: "not-markdown" | "outside-workspace";
}> {
  let path = normalizeWorkspaceAgentFilePath(input.path);
  if (!path) {
    return {
      file: null,
      reason: isWorkspaceAgentMarkdownPath(input.path) ? "outside-workspace" : "not-markdown",
    };
  }

  let segments = splitWorkspaceAgentPath(path);
  let fileName = segments.pop()!;
  let scannedDirectories = 0;
  let load = async (directoryPath: string, name: string, root = false) => {
    if (scannedDirectories >= input.limits.maxDirectories) return null;
    scannedDirectories++;
    return await awaitWorkspaceAgentOperation(
      root ? input.tree.readTree() : input.tree.readDirectory(directoryPath, name),
      input.signal,
    );
  };

  try {
    let current = await load("", "", true);
    if (!current) return { file: null, reason: "outside-workspace" };
    let directoryPath = "";
    for (let segment of segments) {
      throwIfWorkspaceAgentAborted(input.signal);
      directoryPath = directoryPath ? `${directoryPath}/${segment}` : segment;
      let child = directChildren(current).find(
        (node): node is MarkdownDirectoryNode =>
          node.kind == "directory" && node.path == directoryPath,
      );
      if (!child) return { file: null, reason: "outside-workspace" };
      current = await load(child.path, child.name);
      if (!current) return { file: null, reason: "outside-workspace" };
    }

    let file = directChildren(current).find(
      (node) => node.kind == "file" && node.path == path && node.name == fileName,
    );
    return {
      file: file?.kind == "file" ? { name: file.name, path: file.path } : null,
      reason: file ? undefined : "outside-workspace",
    };
  } catch (error) {
    throwIfWorkspaceAgentAborted(input.signal);
    return { file: null, issue: workspaceAgentIssue(path, error) };
  }
}

export function normalizeWorkspaceAgentDirectory(path: string | undefined) {
  if (path == null || path.trim() == "") return "";
  return normalizeWorkspaceAgentPath(path);
}

export function normalizeWorkspaceAgentFilePath(path: string) {
  let normalized = normalizeWorkspaceAgentPath(path);
  return normalized && isWorkspaceAgentMarkdownPath(normalized) ? normalized : null;
}

export function isWorkspaceAgentMarkdownPath(path: string) {
  return /(?:^|\/)\.?[^/]*\.md$/i.test(path);
}

export function workspaceAgentPathIsWithinDirectory(path: string, directory: string) {
  return !directory || path.startsWith(`${directory}/`);
}

export function compareWorkspaceAgentPaths(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function normalizeWorkspaceAgentPath(rawPath: string) {
  let trimmed = rawPath.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/") || trimmed.endsWith("/")) return null;
  let segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment == "." || segment == "..")) return null;
  return segments.join("/");
}

function splitWorkspaceAgentPath(path: string) {
  return path ? path.split("/") : [];
}

function directChildren(directory: MarkdownDirectoryNode): MarkdownTreeNode[] {
  return directory.children.filter((node) => {
    let parentPath = node.path.split("/").slice(0, -1).join("/");
    return parentPath == directory.path;
  });
}

function workspaceAgentIssue(path: string, error: unknown): WorkspaceAgentIssue {
  if (isStorageLikeError(error)) {
    return {
      code: error.code,
      message: error.message,
      path,
      retryable: error.retryable,
    };
  }
  return {
    message: error instanceof Error ? error.message : "Workspace operation failed.",
    path,
  };
}

function isStorageLikeError(error: unknown): error is {
  code: WorkspaceAgentIssue["code"];
  message: string;
  retryable: boolean;
} {
  return Boolean(
    error &&
    typeof error == "object" &&
    "message" in error &&
    typeof error.message == "string" &&
    "code" in error &&
    typeof error.code == "string" &&
    "retryable" in error &&
    typeof error.retryable == "boolean",
  );
}

function emptyCatalog(
  directory: string,
  status: WorkspaceAgentCatalogResult["status"],
): WorkspaceAgentCatalogResult {
  return { directory, files: [], issues: [], scannedDirectories: 0, status };
}

function catalogResult(input: Omit<WorkspaceAgentCatalogResult, "status">) {
  let status: WorkspaceAgentCatalogResult["status"] = input.truncationReason
    ? "truncated"
    : input.issues.length
      ? "partial"
      : "complete";
  return { ...input, status };
}
