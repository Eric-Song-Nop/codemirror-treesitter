import { memo, useEffect, useMemo, useRef } from "react";
import { FileTree as TreesFileTree } from "@pierre/trees";
import type { ContextMenuOpenContext } from "@pierre/trees";
import type {
  MarkdownDirectoryNode,
  MarkdownFileNode,
  MarkdownTreeNode,
} from "@/lib/workspace-backend";

type FileTreeProps = {
  onDeleteEntry: (target: FileTreeDeleteTarget) => void;
  onSelectEntry: (target: FileTreeDeleteTarget) => void;
  root: MarkdownDirectoryNode | null;
  selectedPath: null | string;
  onSelectFile: (file: MarkdownFileNode) => void;
};

export type FileTreeDeleteTarget = {
  kind: "directory" | "file";
  name: string;
  path: string;
};

export const FileTree = memo(function FileTree({
  onDeleteEntry,
  onSelectEntry,
  root,
  selectedPath,
  onSelectFile,
}: FileTreeProps) {
  let paths = useMemo(() => (root ? collectTreePaths(root.children) : []), [root]);
  let expandedPaths = useMemo(() => paths.filter((path) => path.endsWith("/")), [paths]);
  let filesByPath = useMemo(() => (root ? collectFilesByPath(root.children) : new Map()), [root]);
  let containerRef = useRef<HTMLDivElement | null>(null);
  let latestSelectionRef = useRef({
    filesByPath,
    onDeleteEntry,
    onSelectEntry,
    onSelectFile,
    selectedPath,
  });
  let modelRef = useRef<TreesFileTree | null>(null);
  let syncingSelectionRef = useRef(false);

  useEffect(() => {
    latestSelectionRef.current = {
      filesByPath,
      onDeleteEntry,
      onSelectEntry,
      onSelectFile,
      selectedPath,
    };
  }, [filesByPath, onDeleteEntry, onSelectEntry, onSelectFile, selectedPath]);

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
            return renderDeleteContextMenu(item, context, (target) => {
              latestSelectionRef.current.onDeleteEntry(normalizeDeleteTarget(target));
            });
          },
          triggerMode: "button",
        },
      },
      icons: {
        colored: true,
        set: "complete",
      },
      initialExpandedPaths: expandedPaths,
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

    model.resetPaths(paths, { initialExpandedPaths: expandedPaths });
  }, [expandedPaths, paths]);

  useEffect(() => {
    let model = modelRef.current;
    if (!model) return;

    syncingSelectionRef.current = true;
    try {
      for (let path of model.getSelectedPaths()) {
        model.getItem(path)?.deselect();
      }

      if (selectedPath) {
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

function renderDeleteContextMenu(
  target: FileTreeDeleteTarget,
  context: ContextMenuOpenContext,
  onDelete: (target: FileTreeDeleteTarget) => void,
) {
  let menu = document.createElement("div");
  menu.className = "local-md-file-tree-context-menu";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;

  let deleteButton = document.createElement("button");
  deleteButton.className = "local-md-file-tree-context-menu-item";
  deleteButton.setAttribute("role", "menuitem");
  deleteButton.type = "button";
  deleteButton.textContent = target.kind == "directory" ? "Delete folder" : "Delete file";
  deleteButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    context.close();
    onDelete(target);
  });

  menu.append(deleteButton);
  return menu;
}

function normalizeDeleteTarget(target: FileTreeDeleteTarget): FileTreeDeleteTarget {
  return {
    ...target,
    path: target.kind == "directory" ? target.path.replace(/\/+$/g, "") : target.path,
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

  let directoryPath = path.replace(/\/+$/g, "");
  if (!directoryPath) return null;

  return {
    kind: "directory",
    name: directoryPath.split("/").at(-1) ?? directoryPath,
    path: directoryPath,
  };
}

function collectTreePaths(nodes: MarkdownTreeNode[]) {
  let paths: string[] = [];
  for (let node of nodes) {
    if (node.kind == "directory") {
      paths.push(`${node.path}/`);
      paths.push(...collectTreePaths(node.children));
    } else {
      paths.push(node.path);
    }
  }
  return paths;
}

function collectFilesByPath(nodes: MarkdownTreeNode[]) {
  let files = new Map<string, MarkdownFileNode>();
  for (let node of nodes) {
    if (node.kind == "directory") {
      for (let [path, file] of collectFilesByPath(node.children)) {
        files.set(path, file);
      }
    } else {
      files.set(node.path, node);
    }
  }
  return files;
}
