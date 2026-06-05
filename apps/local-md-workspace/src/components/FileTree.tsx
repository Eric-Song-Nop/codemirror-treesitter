import { memo, useEffect, useMemo, useRef } from "react";
import { FileTree as TreesFileTree } from "@pierre/trees";
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

const fileTreeIconSpriteSheet = `<svg data-icon-sprite aria-hidden="true" width="0" height="0">
  <symbol id="local-md-icon-trash" viewBox="0 0 24 24">
    <path d="M3 6h18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>
    <path d="m19 6-1 14c-.1 1.1-1 2-2 2H8c-1.1 0-1.9-.9-2-2L5 6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>
    <path d="M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>
  </symbol>
</svg>`;

const fileTreeUnsafeCSS = `
  [data-type='context-menu-trigger'] {
    border-radius: 6px;
  }

  [data-type='context-menu-trigger']:hover,
  [data-type='context-menu-trigger'][aria-expanded='true'] {
    color: #ef4444;
  }
`;

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
          onOpen(item, context) {
            context.close({ restoreFocus: false });
            latestSelectionRef.current.onDeleteEntry(normalizeDeleteTarget(item));
          },
          triggerMode: "button",
        },
      },
      icons: {
        colored: true,
        remap: {
          "file-tree-icon-ellipsis": {
            name: "local-md-icon-trash",
            viewBox: "0 0 24 24",
          },
        },
        set: "complete",
        spriteSheet: fileTreeIconSpriteSheet,
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
      unsafeCSS: fileTreeUnsafeCSS,
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
