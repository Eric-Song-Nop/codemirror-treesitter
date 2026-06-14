export type WorkspaceBackendKind = "local" | "opendal-dropbox" | "opendal-s3";

export type MarkdownFileNode = {
  kind: "file";
  name: string;
  path: string;
};

export type MarkdownDirectoryNode = {
  children: MarkdownTreeNode[];
  kind: "directory";
  name: string;
  path: string;
};

export type MarkdownTreeNode = MarkdownDirectoryNode | MarkdownFileNode;

export type WorkspaceImageNode = {
  file: File;
  name: string;
  path: string;
};

export type CreatedWorkspaceImageNode = WorkspaceImageNode & {
  markdownReference: string;
};

export type WorkspaceEntry = {
  isDirectory: boolean;
  isFile: boolean;
  path: string;
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
  readImages?: () => Promise<WorkspaceImageNode[]>;
  readTextFile?: (path: string) => Promise<string>;
  readTree(): Promise<MarkdownDirectoryNode>;
  renameEntry?: (from: string, to: string) => Promise<void>;
  renameDirectory?: (path: string, rawName: string) => Promise<string>;
  renameFile(path: string, rawName: string): Promise<string>;
  stat?: (path: string) => Promise<WorkspaceEntryStat>;
  writeBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  writeFile(path: string, value: string): Promise<void>;
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

function collectMarkdownFiles(nodes: MarkdownTreeNode[], files: MarkdownFileNode[]) {
  for (let node of nodes) {
    if (node.kind == "file") {
      files.push(node);
    } else {
      collectMarkdownFiles(node.children, files);
    }
  }
}

export function isHiddenLiveMdPath(path: string) {
  return path == ".livemd" || path.startsWith(".livemd/");
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
