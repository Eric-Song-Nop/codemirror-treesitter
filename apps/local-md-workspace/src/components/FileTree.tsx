import { memo, useEffect, useMemo, useRef } from "react";
import { FileTree as TreesFileTree } from "@pierre/trees";
import type { MarkdownDirectoryNode, MarkdownFileNode, MarkdownTreeNode } from "@/lib/file-system";

type FileTreeProps = {
  root: MarkdownDirectoryNode | null;
  selectedPath: null | string;
  onSelectFile: (file: MarkdownFileNode) => void;
};

export const FileTree = memo(function FileTree({
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
    onSelectFile,
    selectedPath,
  });
  let modelRef = useRef<TreesFileTree | null>(null);
  let syncingSelectionRef = useRef(false);

  useEffect(() => {
    latestSelectionRef.current = {
      filesByPath,
      onSelectFile,
      selectedPath,
    };
  }, [filesByPath, onSelectFile, selectedPath]);

  useEffect(() => {
    let container = containerRef.current;
    if (!container) return;

    let model = new TreesFileTree({
      density: "compact",
      flattenEmptyDirectories: true,
      icons: {
        colored: true,
        set: "minimal",
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
          selectedPath,
        } = latestSelectionRef.current;
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

  return <div ref={containerRef} className="local-md-file-tree min-h-0 flex-1" />;
});

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
