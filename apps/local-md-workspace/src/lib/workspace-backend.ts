export type WorkspaceBackendKind =
  | "local"
  | "opendal-dropbox"
  | "opendal-gdrive"
  | "opendal-onedrive"
  | "opendal-s3";

export type WorkspaceSourceRevision = {
  etag?: string;
  version?: string;
};

export type WorkspaceSourceAlias = {
  kind: WorkspaceBackendKind;
  namespace: string;
  workspaceId: string;
};

export type WorkspaceWriteOptions = {
  baseRevision?: WorkspaceSourceRevision;
  ifNotExists?: boolean;
};

export type WorkspaceWriteResult = {
  revision?: WorkspaceSourceRevision;
};

export type MarkdownFileNode = {
  kind: "file";
  name: string;
  path: string;
};

export type MarkdownDirectoryNode = {
  children: MarkdownTreeNode[];
  childrenLoaded?: boolean;
  kind: "directory";
  name: string;
  path: string;
};

export type MarkdownTreeNode = MarkdownDirectoryNode | MarkdownFileNode;

export type WorkspaceImageAssetNode = {
  file: File;
  name: string;
  path: string;
};

export type CreatedWorkspaceImageNode = WorkspaceImageAssetNode & {
  markdownReference: string;
};

export type WorkspaceEntry = {
  isDirectory: boolean;
  isFile: boolean;
  path: string;
  revision?: WorkspaceSourceRevision;
};

export type WorkspaceEntryStat = WorkspaceEntry & {
  exists: boolean;
  mtime?: number;
  size?: number;
};

export type WorkspaceBackend = {
  id: string;
  kind: WorkspaceBackendKind;
  name: string;
  sourceAliases?: WorkspaceSourceAlias[];
  createDirectory?: (path: string) => Promise<void>;
  createFile(path: string): Promise<string | null>;
  createImageAsset?: (
    markdownFilePath: string,
    imageFile: File,
  ) => Promise<CreatedWorkspaceImageNode>;
  deleteEntry?: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  deleteDirectory?: (path: string) => Promise<void>;
  deleteFile(path: string): Promise<void>;
  findFilePathForHandle?: (handle: unknown) => Promise<string | null>;
  listEntries?: (path: string) => Promise<WorkspaceEntry[]>;
  readBytes?: (path: string) => Promise<Uint8Array>;
  readFile(path: string): Promise<string>;
  readTextFile?: (path: string) => Promise<string>;
  readTree(): Promise<MarkdownDirectoryNode>;
  renameEntry?: (from: string, to: string) => Promise<void>;
  renameDirectory?: (path: string, rawName: string) => Promise<string>;
  renameFile(path: string, rawName: string): Promise<string>;
  stat?: (path: string) => Promise<WorkspaceEntryStat>;
  writeBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  writeFile(
    path: string,
    value: string,
    options?: WorkspaceWriteOptions,
  ): Promise<void | WorkspaceWriteResult>;
  writeTextFile?: (path: string, value: string) => Promise<void>;
};

export type WorkspaceCreateTarget =
  | {
      kind: "directory";
      path: string;
    }
  | {
      kind: "file";
      path: string;
    };

export function flattenMarkdownFiles(tree: MarkdownDirectoryNode) {
  let files: MarkdownFileNode[] = [];
  collectMarkdownFiles(tree.children, files);
  return files;
}

export function findMarkdownFile(tree: MarkdownDirectoryNode | null, path: string | null) {
  if (!tree || !path) return null;
  return findMarkdownFileInNodes(tree.children, path);
}

export function findMarkdownDirectory(tree: MarkdownDirectoryNode | null, path: string | null) {
  if (!tree || path == null) return null;
  if (tree.path == path) return tree;
  return findMarkdownDirectoryInNodes(tree.children, path);
}

export function replaceMarkdownDirectory(
  tree: MarkdownDirectoryNode,
  directory: MarkdownDirectoryNode,
): MarkdownDirectoryNode {
  let nextDirectory = mergeLoadedDirectory(tree, directory);
  if (tree.path == directory.path) return nextDirectory;

  let replaced = false;
  let children: MarkdownTreeNode[] = tree.children.map((node): MarkdownTreeNode => {
    if (node.kind == "file") return node;
    if (node.path == directory.path) {
      replaced = true;
      return mergeLoadedDirectory(node, directory);
    }
    let nextNode: MarkdownDirectoryNode = replaceMarkdownDirectory(node, directory);
    if (nextNode !== node) replaced = true;
    return nextNode;
  });

  return replaced ? { ...tree, children: sortMarkdownTreeNodes(children) } : tree;
}

export function normalizeMarkdownPath(rawPath: string) {
  let parts = splitUserPath(rawPath);
  if (!parts.length) throw new Error("Enter a file name.");

  let fileName = parts[parts.length - 1]!;
  if (!/\.md$/i.test(fileName)) fileName = `${fileName}.md`;
  parts[parts.length - 1] = fileName;
  return parts.join("/");
}

export function normalizeWorkspaceCreateTarget(rawPath: string): WorkspaceCreateTarget {
  let trimmed = rawPath.trim().replace(/\\/g, "/");
  let parts = splitUserPath(trimmed);
  let createDirectory = trimmed.endsWith("/");
  if (!parts.length)
    throw new Error(createDirectory ? "Enter a folder name." : "Enter a file name.");

  if (createDirectory) {
    return {
      kind: "directory",
      path: parts.join("/"),
    };
  }

  let fileName = parts[parts.length - 1]!;
  if (!/\.md$/i.test(fileName)) fileName = `${fileName}.md`;
  parts[parts.length - 1] = fileName;
  return {
    kind: "file",
    path: parts.join("/"),
  };
}

export function normalizeMarkdownFileName(rawName: string) {
  let parts = splitUserPath(rawName);
  if (parts.length != 1) throw new Error("Enter a file name, not a path.");

  let fileName = parts[0]!;
  return /\.md$/i.test(fileName) ? fileName : `${fileName}.md`;
}

export function normalizeWorkspaceDirectoryName(rawName: string) {
  let parts = splitUserPath(rawName);
  if (parts.length != 1) throw new Error("Enter a folder name, not a path.");
  return parts[0]!;
}

export function starterMarkdown(path: string) {
  let title = path.split("/").at(-1)!.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return title ? `# ${title}\n` : "";
}

export function writeNewWorkspaceFile(
  backend: Pick<WorkspaceBackend, "writeFile">,
  path: string,
  value: string,
) {
  return backend.writeFile(path, value, { ifNotExists: true });
}

export function joinWorkspacePath(parentPath: string, name: string) {
  return parentPath ? `${parentPath}/${name}` : name;
}

export function sortMarkdownTreeNodes(nodes: MarkdownTreeNode[]) {
  return nodes.sort(compareMarkdownTreeNodes);
}

export function compareMarkdownTreeNodes(a: MarkdownTreeNode, b: MarkdownTreeNode) {
  if (a.kind != b.kind) return a.kind == "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function buildMarkdownTreeFromPaths(name: string, paths: string[]) {
  return buildMarkdownTreeFromEntries(
    name,
    paths.map((path) => ({
      isDirectory: false,
      isFile: true,
      path,
    })),
  );
}

export function buildMarkdownTreeFromEntries(name: string, entries: WorkspaceEntry[]) {
  let root: MarkdownDirectoryNode = {
    children: [],
    childrenLoaded: true,
    kind: "directory",
    name,
    path: "",
  };

  let directories = new Map<string, MarkdownDirectoryNode>([["", root]]);

  let ensureDirectory = (directoryPath: string) => {
    let parent = root;
    let parentPath = "";
    for (let part of directoryPath.split("/").filter(Boolean)) {
      let path = joinWorkspacePath(parentPath, part);
      let directory = directories.get(path);
      if (!directory) {
        directory = {
          children: [],
          childrenLoaded: true,
          kind: "directory",
          name: part,
          path,
        };
        directories.set(path, directory);
        parent.children.push(directory);
      }

      parent = directory;
      parentPath = path;
    }
    return parent;
  };

  for (let entry of entries) {
    let path = normalizeBackendPath(entry.path);
    if (!path) continue;
    if (isHiddenLiveMdPath(path)) continue;

    if (entry.isDirectory) {
      ensureDirectory(path);
      continue;
    }
    if (!entry.isFile || !/\.md$/i.test(path)) continue;

    let parts = path.split("/");
    let fileName = parts.pop();
    if (!fileName) continue;

    let parent = ensureDirectory(parts.join("/"));

    parent.children.push({
      kind: "file",
      name: fileName,
      path,
    });
  }

  sortTree(root);
  return root;
}

export function buildMarkdownDirectoryFromEntries(
  name: string,
  path: string,
  entries: WorkspaceEntry[],
) {
  let childrenByPath = new Map<string, MarkdownTreeNode>();
  let normalizedDirectoryPath = normalizeBackendPath(path);

  for (let entry of entries) {
    let child = workspaceEntryToDirectMarkdownNode(normalizedDirectoryPath, entry);
    if (!child) continue;
    childrenByPath.set(child.path, child);
  }

  return {
    children: sortMarkdownTreeNodes([...childrenByPath.values()]),
    childrenLoaded: true,
    kind: "directory",
    name,
    path: normalizedDirectoryPath,
  } satisfies MarkdownDirectoryNode;
}

function collectMarkdownFiles(nodes: MarkdownTreeNode[], files: MarkdownFileNode[]) {
  for (let node of nodes) {
    if (node.kind == "file") {
      files.push(node);
    } else {
      collectMarkdownFiles(node.children, files);
    }
  }
}

function findMarkdownFileInNodes(nodes: MarkdownTreeNode[], path: string): MarkdownFileNode | null {
  for (let node of nodes) {
    if (node.kind == "file") {
      if (node.path == path) return node;
    } else {
      let file = findMarkdownFileInNodes(node.children, path);
      if (file) return file;
    }
  }
  return null;
}

function findMarkdownDirectoryInNodes(
  nodes: MarkdownTreeNode[],
  path: string,
): MarkdownDirectoryNode | null {
  for (let node of nodes) {
    if (node.kind == "file") continue;
    if (node.path == path) return node;
    let directory = findMarkdownDirectoryInNodes(node.children, path);
    if (directory) return directory;
  }
  return null;
}

export function isHiddenLiveMdPath(path: string) {
  return path == ".livemd" || path.startsWith(".livemd/");
}

function workspaceEntryToDirectMarkdownNode(parentPath: string, entry: WorkspaceEntry) {
  let path = normalizeBackendPath(entry.path);
  if (!path) return null;
  if (isHiddenLiveMdPath(path)) return null;

  let relativePath = directChildRelativePath(parentPath, path);
  if (!relativePath) return null;

  let [childName, nested] = relativePath.split("/");
  if (!childName) return null;

  let childPath = joinWorkspacePath(parentPath, childName);
  if (entry.isDirectory || nested) {
    return {
      children: [],
      childrenLoaded: false,
      kind: "directory",
      name: childName,
      path: childPath,
    } satisfies MarkdownDirectoryNode;
  }

  if (!entry.isFile || !/\.md$/i.test(childName)) return null;
  return {
    kind: "file",
    name: childName,
    path: childPath,
  } satisfies MarkdownFileNode;
}

function directChildRelativePath(parentPath: string, path: string) {
  if (!parentPath) return path;
  if (path == parentPath) return "";
  return path.startsWith(`${parentPath}/`) ? path.slice(parentPath.length + 1) : "";
}

function mergeLoadedDirectory(current: MarkdownDirectoryNode, next: MarkdownDirectoryNode) {
  if (current.path != next.path) return current;

  let currentLoadedChildren = new Map(
    current.children
      .filter((node): node is MarkdownDirectoryNode => node.kind == "directory")
      .filter((node) => node.childrenLoaded)
      .map((node) => [node.path, node]),
  );
  let children = next.children.map((node) => {
    if (node.kind == "file") return node;
    let loadedChild = currentLoadedChildren.get(node.path);
    return loadedChild ? { ...node, children: loadedChild.children, childrenLoaded: true } : node;
  });

  return { ...next, children: sortMarkdownTreeNodes(children) };
}

function sortTree(directory: MarkdownDirectoryNode) {
  for (let node of directory.children) {
    if (node.kind == "directory") sortTree(node);
  }
  sortMarkdownTreeNodes(directory.children);
}

function splitUserPath(rawPath: string) {
  let normalized = rawPath
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (normalized.some((part) => part == "." || part == "..")) {
    throw new Error("File paths cannot include . or ..");
  }

  return normalized;
}

function normalizeBackendPath(rawPath: string) {
  let parts = rawPath
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.some((part) => part == "." || part == "..")) return "";
  return parts.join("/");
}
