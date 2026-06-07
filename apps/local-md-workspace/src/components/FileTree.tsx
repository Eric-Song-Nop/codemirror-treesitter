import { memo, useEffect, useMemo, useRef } from "react";
import { FileTree as TreesFileTree } from "@pierre/trees";
import type {
  ContextMenuOpenContext,
  FileTreeBatchOperation,
  FileTreeDirectoryHandle,
} from "@pierre/trees";
import { basename, dirname, join, normalize, relative } from "pathe";
import type {
  MarkdownDirectoryNode,
  MarkdownFileNode,
  MarkdownTreeNode,
} from "@/lib/workspace-backend";
import { flattenMarkdownFiles } from "@/lib/workspace-backend";

type FileTreeProps = {
  onCreateEntry: (target: FileTreeDeleteTarget, kind: FileTreeCreateKind) => void;
  onDeleteEntry: (target: FileTreeDeleteTarget) => void;
  onRenameEntry: (target: FileTreeDeleteTarget) => void;
  onSelectEntry: (target: FileTreeDeleteTarget) => void;
  root: MarkdownDirectoryNode | null;
  selectedPath: null | string;
  onSelectFile: (file: MarkdownFileNode) => void;
};

export type FileTreeCreateKind = "directory" | "file";

export type FileTreeDeleteTarget = {
  kind: "directory" | "file";
  name: string;
  path: string;
};

export const FileTree = memo(function FileTree({
  onCreateEntry,
  onDeleteEntry,
  onRenameEntry,
  onSelectEntry,
  root,
  selectedPath,
  onSelectFile,
}: FileTreeProps) {
  let paths = useMemo(() => (root ? collectTreePaths(root.children) : []), [root]);
  let filesByPath = useMemo(
    () => new Map(root ? flattenMarkdownFiles(root).map((file) => [file.path, file]) : []),
    [root],
  );
  let containerRef = useRef<HTMLDivElement | null>(null);
  let initialExpandedDirectoryPathRef = useRef(treeDirectoryPathForFile(selectedPath));
  let pathsRef = useRef(paths);
  let latestSelectionRef = useRef({
    filesByPath,
    onCreateEntry,
    onDeleteEntry,
    onRenameEntry,
    onSelectEntry,
    onSelectFile,
    selectedPath,
  });
  let modelRef = useRef<TreesFileTree | null>(null);
  let syncingSelectionRef = useRef(false);

  useEffect(() => {
    latestSelectionRef.current = {
      filesByPath,
      onCreateEntry,
      onDeleteEntry,
      onRenameEntry,
      onSelectEntry,
      onSelectFile,
      selectedPath,
    };
  }, [
    filesByPath,
    onCreateEntry,
    onDeleteEntry,
    onRenameEntry,
    onSelectEntry,
    onSelectFile,
    selectedPath,
  ]);

  useEffect(() => {
    let container = containerRef.current;
    if (!container) return;

    let model = new TreesFileTree({
      density: "compact",
      flattenEmptyDirectories: true,
      composition: {
        contextMenu: {
          buttonVisibility: "when-needed",
          enabled: true,
          render(item, context) {
            return renderFileTreeContextMenu(item, context, {
              create(target, kind) {
                latestSelectionRef.current.onCreateEntry(normalizeDeleteTarget(target), kind);
              },
              delete(target) {
                latestSelectionRef.current.onDeleteEntry(normalizeDeleteTarget(target));
              },
              rename(target) {
                latestSelectionRef.current.onRenameEntry(normalizeDeleteTarget(target));
              },
            });
          },
          triggerMode: "button",
        },
      },
      icons: {
        colored: true,
        set: "complete",
      },
      initialExpandedPaths: initialExpandedDirectoryPathRef.current
        ? [initialExpandedDirectoryPathRef.current]
        : [],
      initialSelectedPaths: selectedPath ? [selectedPath] : [],
      paths,
      search: false,
      stickyFolders: false,
      onSelectionChange(selectedPaths) {
        if (syncingSelectionRef.current) return;

        let nextPath = selectedPaths.at(-1);
        if (!nextPath) return;

        let {
          filesByPath: latestFilesByPath,
          onSelectFile: latestOnSelectFile,
          onSelectEntry: latestOnSelectEntry,
          selectedPath,
        } = latestSelectionRef.current;
        let target = resolveSelectionTarget(nextPath, latestFilesByPath);
        if (target) latestOnSelectEntry(target);
        if (nextPath == selectedPath) return;

        let file = latestFilesByPath.get(nextPath);
        if (file) latestOnSelectFile(file);
      },
    });

    modelRef.current = model;
    model.render({ containerWrapper: container });

    return () => {
      model.cleanUp();
      modelRef.current = null;
    };
  }, []);

  useEffect(() => {
    let model = modelRef.current;
    if (!model) return;

    syncTreePaths(model, pathsRef.current, paths);
    pathsRef.current = paths;
  }, [paths]);

  useEffect(() => {
    let model = modelRef.current;
    if (!model) return;

    syncingSelectionRef.current = true;
    try {
      for (let path of model.getSelectedPaths()) {
        model.getItem(path)?.deselect();
      }

      if (selectedPath) {
        let directoryPath = treeDirectoryPathForFile(selectedPath);
        let directory = directoryPath ? model.getItem(directoryPath) : null;
        if (directory?.isDirectory()) (directory as FileTreeDirectoryHandle).expand();
        let item = model.getItem(selectedPath);
        item?.select();
        item?.focus();
        model.scrollToPath(selectedPath, { focus: false });
      }
    } finally {
      syncingSelectionRef.current = false;
    }
  }, [paths, selectedPath]);

  if (!root) return null;

  return <div ref={containerRef} className="local-md-file-tree min-h-0 flex-1 overflow-auto" />;
});

function renderFileTreeContextMenu(
  target: FileTreeDeleteTarget,
  context: ContextMenuOpenContext,
  actions: {
    create: (target: FileTreeDeleteTarget, kind: FileTreeCreateKind) => void;
    delete: (target: FileTreeDeleteTarget) => void;
    rename: (target: FileTreeDeleteTarget) => void;
  },
) {
  let menu = document.createElement("div");
  menu.className = "local-md-file-tree-context-menu";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;

  menu.append(
    renderContextMenuItem("New file", context, () => actions.create(target, "file")),
    renderContextMenuItem("New folder", context, () => actions.create(target, "directory")),
    renderContextMenuItem("Rename", context, () => actions.rename(target)),
    renderContextMenuSeparator(),
    renderContextMenuItem("Delete", context, () => actions.delete(target), { destructive: true }),
  );
  return menu;
}

function renderContextMenuItem(
  label: string,
  context: ContextMenuOpenContext,
  onSelect: () => void,
  options: { destructive?: boolean } = {},
) {
  let button = document.createElement("button");
  button.className = "local-md-file-tree-context-menu-item";
  if (options.destructive) button.dataset.destructive = "true";
  button.setAttribute("role", "menuitem");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    context.close();
    onSelect();
  });
  return button;
}

function renderContextMenuSeparator() {
  let separator = document.createElement("div");
  separator.className = "local-md-file-tree-context-menu-separator";
  separator.setAttribute("role", "separator");
  return separator;
}

function normalizeDeleteTarget(target: FileTreeDeleteTarget): FileTreeDeleteTarget {
  return {
    ...target,
    path: target.kind == "directory" ? workspaceDirectoryPath(target.path) : target.path,
  };
}

function resolveSelectionTarget(
  path: string,
  filesByPath: Map<string, MarkdownFileNode>,
): FileTreeDeleteTarget | null {
  let file = filesByPath.get(path);
  if (file) {
    return {
      kind: "file",
      name: file.name,
      path: file.path,
    };
  }

  let directoryPath = workspaceDirectoryPath(path);
  if (!directoryPath) return null;

  return {
    kind: "directory",
    name: basename(directoryPath),
    path: directoryPath,
  };
}

function collectTreePaths(nodes: MarkdownTreeNode[]) {
  let paths: string[] = [];
  for (let node of nodes) {
    if (node.kind == "directory") {
      paths.push(treeDirectoryPath(node.path));
      paths.push(...collectTreePaths(node.children));
    } else {
      paths.push(node.path);
    }
  }
  return paths;
}

function syncTreePaths(model: TreesFileTree, previousPaths: string[], nextPaths: string[]) {
  let previousPathSet = new Set(previousPaths);
  let nextPathSet = new Set(nextPaths);
  let removedDirectoryPaths = previousPaths.filter(
    (path) => isTreeDirectoryPath(path) && !nextPathSet.has(path),
  );
  let operations: FileTreeBatchOperation[] = [];

  for (let path of previousPaths) {
    if (nextPathSet.has(path) || hasRemovedAncestorDirectory(path, removedDirectoryPaths)) continue;
    operations.push({ path, recursive: isTreeDirectoryPath(path), type: "remove" });
  }

  for (let path of nextPaths) {
    if (!previousPathSet.has(path)) operations.push({ path, type: "add" });
  }

  if (operations.length) model.batch(operations);
}

function hasRemovedAncestorDirectory(path: string, removedDirectoryPaths: string[]) {
  return removedDirectoryPaths.some((directoryPath) => isPathInsideDirectory(path, directoryPath));
}

function treeDirectoryPathForFile(path: null | string) {
  if (!path) return null;

  let directoryPath = dirname(path);
  return directoryPath == "." ? null : treeDirectoryPath(directoryPath);
}

function treeDirectoryPath(path: string) {
  return join(normalize(path), "/");
}

function workspaceDirectoryPath(path: string) {
  let directoryPath = normalize(path);
  if (directoryPath == "." || directoryPath == "/") return "";
  return isTreeDirectoryPath(directoryPath)
    ? join(dirname(directoryPath), basename(directoryPath))
    : directoryPath;
}

function isPathInsideDirectory(path: string, directoryPath: string) {
  let relativePath = relative(normalize(directoryPath), normalize(path));
  return relativePath != "" && relativePath != ".." && !relativePath.startsWith("../");
}

function isTreeDirectoryPath(path: string) {
  return path.endsWith("/");
}
