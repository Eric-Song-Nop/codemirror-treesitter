import { memo, useEffect, useMemo, useRef, useState } from "react";
import { FileTree as TreesFileTree } from "@pierre/trees";
import { basename, dirname, join, relative } from "pathe";
import { Spinner } from "@/components/ui/spinner";
import type {
  MarkdownDirectoryNode,
  MarkdownFileNode,
  MarkdownTreeNode,
} from "@/lib/workspace/tree";
import { findMarkdownDirectory, findMarkdownFile } from "@/lib/workspace/tree";
import { useI18n, type TFunction } from "@/lib/i18n";

type FileTreeProps = {
  onCreateEntry: (target: FileTreeDeleteTarget, kind: FileTreeCreateKind) => void;
  onDeleteEntry: (target: FileTreeDeleteTarget) => void;
  onRenameEntry: (target: FileTreeDeleteTarget) => void;
  onSelectEntry: (target: FileTreeDeleteTarget) => void;
  onLoadDirectory: (path: string) => Promise<void>;
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
  onLoadDirectory,
  root,
  selectedPath,
  onSelectFile,
}: FileTreeProps) {
  let { t } = useI18n();
  let paths = useMemo(() => (root ? collectTreePaths(root.children) : []), [root]);
  let latestSelection = {
    onCreateEntry,
    onDeleteEntry,
    onRenameEntry,
    onSelectEntry,
    onLoadDirectory,
    onSelectFile,
    root,
    selectedPath,
    t,
  };
  let containerRef = useRef<HTMLDivElement | null>(null);
  let initialExpandedDirectoryPathRef = useRef(treeDirectoryPathForFile(selectedPath));
  let pathsRef = useRef(paths);
  let latestSelectionRef = useRef(latestSelection);
  let loadingDirectoryPathsRef = useRef(new Set<string>());
  let modelRef = useRef<TreesFileTree | null>(null);
  let syncingSelectionRef = useRef(false);
  let [loadingDirectoryPath, setLoadingDirectoryPath] = useState<string | null>(null);
  latestSelectionRef.current = latestSelection;

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
            return renderFileTreeContextMenu(
              item,
              context,
              {
                create(target, kind) {
                  latestSelectionRef.current.onCreateEntry(normalizeDeleteTarget(target), kind);
                },
                delete(target) {
                  latestSelectionRef.current.onDeleteEntry(normalizeDeleteTarget(target));
                },
                rename(target) {
                  latestSelectionRef.current.onRenameEntry(normalizeDeleteTarget(target));
                },
              },
              latestSelectionRef.current.t,
            );
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

        let latest = latestSelectionRef.current;
        let target = resolveSelectionTarget(nextPath, latest.root);
        if (target) {
          latest.onSelectEntry(target);
          let loadingDirectoryPaths = loadingDirectoryPathsRef.current;
          if (
            target.kind == "directory" &&
            shouldLoadDirectory(latest.root, target.path) &&
            !loadingDirectoryPaths.has(target.path)
          ) {
            loadingDirectoryPaths.add(target.path);
            setLoadingDirectoryPath(target.path);
            void latest
              .onLoadDirectory(target.path)
              .finally(() => {
                loadingDirectoryPaths.delete(target.path);
                setLoadingDirectoryPath((currentPath) =>
                  currentPath == target.path
                    ? (loadingDirectoryPaths.values().next().value ?? null)
                    : currentPath,
                );
              })
              .catch(() => {});
          }
        }
        if (nextPath == latest.selectedPath) return;

        let file = findMarkdownFile(latest.root, nextPath);
        if (file) latest.onSelectFile(file);
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
        if (directory && "expand" in directory) directory.expand();
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {loadingDirectoryPath && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-sidebar-border px-3 text-xs text-sidebar-foreground/70">
          <Spinner aria-hidden className="size-3" />
          <span className="min-w-0 truncate">
            {t("workspace.loadingDirectory", { path: loadingDirectoryPath })}
          </span>
        </div>
      )}
      <div ref={containerRef} className="local-md-file-tree min-h-0 flex-1 overflow-auto" />
    </div>
  );
});

function shouldLoadDirectory(root: MarkdownDirectoryNode | null, path: string) {
  let directory = findMarkdownDirectory(root, path);
  return Boolean(directory && !directory.childrenLoaded);
}

function renderFileTreeContextMenu(
  target: FileTreeDeleteTarget,
  context: { close(): void },
  actions: {
    create: (target: FileTreeDeleteTarget, kind: FileTreeCreateKind) => void;
    delete: (target: FileTreeDeleteTarget) => void;
    rename: (target: FileTreeDeleteTarget) => void;
  },
  t: TFunction,
) {
  let menu = document.createElement("div");
  menu.className = "local-md-file-tree-context-menu";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;
  let item = (label: string, onSelect: () => void, destructive = false) => {
    let button = document.createElement("button");
    button.className = "local-md-file-tree-context-menu-item";
    if (destructive) button.dataset.destructive = "true";
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
  };
  let separator = document.createElement("div");
  separator.className = "local-md-file-tree-context-menu-separator";
  separator.setAttribute("role", "separator");

  menu.append(
    item(t("fileTree.newFile"), () => actions.create(target, "file")),
    item(t("fileTree.newFolder"), () => actions.create(target, "directory")),
    item(t("fileTree.rename"), () => actions.rename(target)),
    separator,
    item(t("fileTree.delete"), () => actions.delete(target), true),
  );
  return menu;
}

function normalizeDeleteTarget(target: FileTreeDeleteTarget): FileTreeDeleteTarget {
  return {
    ...target,
    path: target.kind == "directory" ? workspaceDirectoryPath(target.path) : target.path,
  };
}

function resolveSelectionTarget(
  path: string,
  root: MarkdownDirectoryNode | null,
): FileTreeDeleteTarget | null {
  let file = findMarkdownFile(root, path);
  if (file) return { kind: "file", name: file.name, path: file.path };

  let directoryPath = workspaceDirectoryPath(path);
  if (!directoryPath) return null;

  return { kind: "directory", name: basename(directoryPath), path: directoryPath };
}

function collectTreePaths(nodes: MarkdownTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind == "directory"
      ? [join(node.path, "/"), ...collectTreePaths(node.children)]
      : [node.path],
  );
}

function syncTreePaths(model: TreesFileTree, previousPaths: string[], nextPaths: string[]) {
  let previousPathSet = new Set(previousPaths);
  let nextPathSet = new Set(nextPaths);
  let removedDirectories = previousPaths.filter(
    (path) => path.endsWith("/") && !nextPathSet.has(path),
  );
  let operations = [
    ...previousPaths
      .filter(
        (path) =>
          !nextPathSet.has(path) &&
          !removedDirectories.some((directory) => isInside(path, directory)),
      )
      .map((path) => ({ path, recursive: path.endsWith("/"), type: "remove" as const })),
    ...nextPaths
      .filter((path) => !previousPathSet.has(path))
      .map((path) => ({ path, type: "add" as const })),
  ];

  if (operations.length) model.batch(operations);
}

function treeDirectoryPathForFile(path: null | string) {
  if (!path) return null;

  let directoryPath = dirname(path);
  return directoryPath == "." ? null : join(directoryPath, "/");
}

function workspaceDirectoryPath(path: string) {
  let directoryPath = join(dirname(path), basename(path));
  if (directoryPath == "." || directoryPath == "/") return "";
  return directoryPath;
}

function isInside(path: string, directoryPath: string) {
  let relativePath = relative(directoryPath, path);
  return relativePath != "" && relativePath != ".." && !relativePath.startsWith("../");
}
