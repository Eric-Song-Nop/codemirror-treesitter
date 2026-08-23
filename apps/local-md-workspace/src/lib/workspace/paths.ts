import type { FileTreeDeleteTarget } from "@/components/FileTree";
import type { TFunction } from "@/lib/i18n";
import { findMarkdownFile, type MarkdownDirectoryNode } from "@/lib/workspace-tree";

export function isPathInsideDirectory(path: string, directory: string) {
  let normalizedDirectory = directory.replace(/\/+$/g, "");
  return path == normalizedDirectory || path.startsWith(`${normalizedDirectory}/`);
}

export function pathAfterDirectoryRename(
  selectedPath: string | null,
  currentDirectoryPath: string,
  nextDirectoryPath: string,
) {
  if (!selectedPath?.startsWith(`${currentDirectoryPath}/`)) return selectedPath;
  return `${nextDirectoryPath}${selectedPath.slice(currentDirectoryPath.length)}`;
}

export function defaultNewFilePath(
  tree: MarkdownDirectoryNode | null,
  selection: FileTreeDeleteTarget | null,
  t: TFunction,
) {
  let today = new Date().toISOString().slice(0, 10);
  let parentPath =
    selection?.kind == "directory"
      ? selection.path
      : selection?.kind == "file"
        ? directoryPath(selection.path)
        : "";
  let baseName = `${today}.md`;
  let basePath = joinWorkspacePath(parentPath, baseName);
  if (!findMarkdownFile(tree, basePath)) return basePath;

  for (let index = 2; index < 1000; index += 1) {
    let path = joinWorkspacePath(parentPath, `${today}-${index}.md`);
    if (!findMarkdownFile(tree, path)) return path;
  }

  return joinWorkspacePath(parentPath, t("defaults.untitledFile"));
}

export function defaultNewFolderPath(
  tree: MarkdownDirectoryNode | null,
  selection: FileTreeDeleteTarget | null,
  t: TFunction,
) {
  let parentPath =
    selection?.kind == "directory"
      ? selection.path
      : selection?.kind == "file"
        ? directoryPath(selection.path)
        : "";
  let directoryPaths = tree ? collectDirectoryPaths(tree) : new Set<string>();
  let basePath = joinWorkspacePath(parentPath, t("defaults.newFolder"));
  if (!directoryPaths.has(basePath)) return `${basePath}/`;

  for (let index = 2; index < 1000; index += 1) {
    let path = joinWorkspacePath(parentPath, `${t("defaults.newFolder")} ${index}`);
    if (!directoryPaths.has(path)) return `${path}/`;
  }

  return joinWorkspacePath(parentPath, t("defaults.untitledFolder"));
}

function directoryPath(path: string) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function joinWorkspacePath(parent: string, child: string) {
  return parent ? `${parent}/${child}` : child;
}

function collectDirectoryPaths(root: MarkdownDirectoryNode) {
  let paths = new Set<string>();
  let visit = (directory: MarkdownDirectoryNode) => {
    if (directory.path) paths.add(directory.path);
    for (let child of directory.children) {
      if (child.kind == "directory") visit(child);
    }
  };
  visit(root);
  return paths;
}
