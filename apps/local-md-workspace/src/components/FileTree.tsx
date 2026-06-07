import { memo, useEffect, useMemo, useRef } from "react";
import { FileTree as TreesFileTree } from "@pierre/trees";
import type { ContextMenuOpenContext } from "@pierre/trees";
import type {
  MarkdownDirectoryNode,
  MarkdownFileNode,
  MarkdownTreeNode,
} from "@/lib/workspace-backend";

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
  let filesByPath = useMemo(() => (root ? collectFilesByPath(root.children) : new Map()), [root]);
  let containerRef = useRef<HTMLDivElement | null>(null);
  let initialExpandedDirectoryPathRef = useRef(parentDirectoryPath(selectedPath));
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

    model.resetPaths(paths);
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
        expandDirectory(model, parentDirectoryPath(selectedPath));
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

function expandDirectory(model: TreesFileTree, path: null | string) {
  if (!path) return;

  let item = model.getItem(path);
  if (item && "expand" in item) item.expand();
}

function parentDirectoryPath(path: null | string) {
  if (!path) return null;

  let slashIndex = path.lastIndexOf("/");
  return slashIndex == -1 ? null : `${path.slice(0, slashIndex)}/`;
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
