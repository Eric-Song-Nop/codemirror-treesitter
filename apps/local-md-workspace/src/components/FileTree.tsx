import { memo, useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, FileTextIcon, FolderIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
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
  let directoryPaths = useMemo(() => (root ? collectDirectoryPaths(root.children) : []), [root]);
  let [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    setExpandedPaths(new Set(directoryPaths));
  }, [directoryPaths]);

  if (!root) return null;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex min-w-0 flex-col gap-0.5 p-2">
        {root.children.map((node) => (
          <TreeNodeRow
            key={node.path}
            depth={0}
            expandedPaths={expandedPaths}
            node={node}
            onSelectFile={onSelectFile}
            selectedPath={selectedPath}
            setExpandedPaths={setExpandedPaths}
          />
        ))}
      </div>
    </ScrollArea>
  );
});

type TreeNodeRowProps = {
  depth: number;
  expandedPaths: Set<string>;
  node: MarkdownTreeNode;
  selectedPath: null | string;
  setExpandedPaths: (update: (paths: Set<string>) => Set<string>) => void;
  onSelectFile: (file: MarkdownFileNode) => void;
};

const TreeNodeRow = memo(function TreeNodeRow({
  depth,
  expandedPaths,
  node,
  onSelectFile,
  selectedPath,
  setExpandedPaths,
}: TreeNodeRowProps) {
  let offset = depth * 14 + 8;

  if (node.kind == "directory") {
    let expanded = expandedPaths.has(node.path);
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-sm text-sidebar-foreground/75 transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          style={{ paddingLeft: offset }}
          onClick={() =>
            setExpandedPaths((paths) => {
              let next = new Set(paths);
              if (next.has(node.path)) {
                next.delete(node.path);
              } else {
                next.add(node.path);
              }
              return next;
            })
          }
        >
          <ChevronRightIcon
            className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
          />
          <FolderIcon className="size-3.5 shrink-0 text-sidebar-foreground/55" />
          <span className="truncate">{node.name}</span>
        </button>
        {expanded &&
          node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              node={child}
              onSelectFile={onSelectFile}
              selectedPath={selectedPath}
              setExpandedPaths={setExpandedPaths}
            />
          ))}
      </div>
    );
  }

  let selected = selectedPath == node.path;
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-sm transition",
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
      style={{ paddingLeft: offset + 17 }}
      onClick={() => onSelectFile(node)}
    >
      <FileTextIcon className="size-3.5 shrink-0 text-sidebar-foreground/55" />
      <span className="truncate">{node.name}</span>
    </button>
  );
});

function collectDirectoryPaths(nodes: MarkdownTreeNode[]) {
  let paths: string[] = [];
  for (let node of nodes) {
    if (node.kind != "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}
