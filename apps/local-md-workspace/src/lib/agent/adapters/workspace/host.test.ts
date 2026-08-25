import { describe, expect, it, vi } from "vite-plus/test";
import type {
  WorkspaceDocuments,
  WorkspaceCollaborativeDocument,
} from "../../../workspace/documents/contracts.ts";
import type { WorkspaceTreePort } from "../../../workspace/runtime/types.ts";
import type { MarkdownDirectoryNode, MarkdownTreeNode } from "../../../workspace/tree.ts";
import type { WorkspaceAgentRuntime } from "../../application/workspace-search.ts";
import { createWorkspaceAgentHost } from "./host.ts";

describe("workspace Agent host", () => {
  it("lists the filtered Markdown tree recursively with stable pagination", async () => {
    let runtime = fakeRuntime({
      files: {
        "README.md": "# Readme",
        "notes/alpha.md": "alpha",
        "notes/beta.md": "beta",
      },
      tree: treePort([
        directory("", "Notes", [
          directory("notes", "notes", [file("notes/alpha.md"), file("notes/beta.md")]),
          file("README.md"),
        ]),
      ]),
    });
    let host = createWorkspaceAgentHost({ runtime, limits: { list: { defaultPageSize: 2 } } });

    let first = await host.listMarkdown();
    expect(first).toMatchObject({
      files: [{ path: "notes/alpha.md" }, { path: "notes/beta.md" }],
      nextCursor: "notes/beta.md",
      status: "complete",
    });
    await expect(host.listMarkdown({ cursor: first.nextCursor })).resolves.toMatchObject({
      files: [{ path: "README.md" }],
      status: "complete",
    });
    await expect(host.listMarkdown({ directory: ".git" })).resolves.toMatchObject({
      files: [],
      status: "not-found",
    });
  });

  it("pages through distinct paths that share the same natural-sort key", async () => {
    let host = createWorkspaceAgentHost({
      limits: { list: { defaultPageSize: 1 } },
      runtime: fakeRuntime({ files: { "A.md": "uppercase", "a.md": "lowercase" } }),
    });

    let first = await host.listMarkdown();
    let second = await host.listMarkdown({ cursor: first.nextCursor });

    expect([...first.files, ...second.files].map((entry) => entry.path)).toEqual(["A.md", "a.md"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("reads and searches authoritative collaborative document values", async () => {
    let document = vi.fn((path: string) => {
      let values: Record<string, string> = {
        "draft.md": "# Draft\nunsaved Needle",
        "other.md": "Needle elsewhere",
      };
      return Promise.resolve(fakeDocument(path, values[path]!));
    });
    let host = createWorkspaceAgentHost({
      runtime: fakeRuntime({
        documents: { close: vi.fn(), document },
        files: { "draft.md": "persisted", "other.md": "persisted" },
      }),
    });

    await expect(
      host.readFile({ lineCount: 1, path: "draft.md", startLine: 2 }),
    ).resolves.toMatchObject({
      endOffset: 22,
      startOffset: 8,
      status: "found",
      text: "unsaved Needle",
    });
    await expect(host.searchMarkdown({ query: "needle" })).resolves.toMatchObject({
      matches: [
        { line: 2, path: "draft.md", preview: "unsaved Needle" },
        { line: 1, path: "other.md", preview: "Needle elsewhere" },
      ],
      status: "complete",
    });
    expect(document).toHaveBeenCalledWith("draft.md");
    expect(document).toHaveBeenCalledWith("other.md");
  });

  it("never opens a Markdown-looking path that the filtered tree does not expose", async () => {
    let document = vi.fn(async (path: string) => fakeDocument(path, "secret"));
    let host = createWorkspaceAgentHost({
      runtime: fakeRuntime({
        documents: { close: vi.fn(), document },
        files: { "public.md": "public" },
      }),
    });

    await expect(host.readFile({ path: ".git/private.md" })).resolves.toEqual({
      path: ".git/private.md",
      reason: "outside-workspace",
      status: "not-found",
    });
    expect(document).not.toHaveBeenCalled();
  });

  it("reports search limits and responds to AbortSignal", async () => {
    let host = createWorkspaceAgentHost({
      limits: { search: { maxMatches: 2 } },
      runtime: fakeRuntime({ files: { "a.md": "hit hit", "b.md": "hit" } }),
    });

    await expect(host.searchMarkdown({ query: "hit" })).resolves.toMatchObject({
      matches: [{ path: "a.md" }, { path: "a.md" }],
      status: "truncated",
      truncationReason: "max-matches",
    });

    let controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(host.searchMarkdown({ query: "hit" }, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("bounds reads and oversized search documents by collaborative content", async () => {
    let host = createWorkspaceAgentHost({
      limits: {
        read: { maxBytes: 8, maxLines: 2 },
        search: { maxFileBytes: 8 },
      },
      runtime: fakeRuntime({ files: { "long.md": "one\ntwo\nthree" } }),
    });

    await expect(host.readFile({ lineCount: 10, path: "long.md" })).resolves.toMatchObject({
      endLine: 2,
      endOffset: 8,
      startLine: 1,
      startOffset: 0,
      status: "found",
      text: "one\ntwo\n",
      totalLines: 3,
      truncated: true,
    });
    await expect(host.searchMarkdown({ query: "three" })).resolves.toMatchObject({
      readBytes: 0,
      skippedLargeFiles: 1,
      status: "truncated",
      truncationReason: "max-file-bytes",
    });
  });

  it("advertises path-based file access and pages to an empty final line", async () => {
    let host = createWorkspaceAgentHost({
      runtime: fakeRuntime({ files: { "trailing.md": "one\n" } }),
    });

    expect(host.getContext()).toMatchObject({
      capabilities: {
        listMarkdown: true,
        readFile: true,
        searchMarkdown: true,
        writeFile: true,
      },
    });
    await expect(host.readFile({ path: "trailing.md", startLine: 2 })).resolves.toMatchObject({
      endLine: 2,
      endOffset: 4,
      startLine: 2,
      startOffset: 4,
      status: "found",
      text: "",
      totalLines: 2,
      truncated: false,
    });
  });
});

function fakeRuntime(input: {
  documents?: WorkspaceDocuments;
  files: Record<string, string>;
  tree?: WorkspaceTreePort;
}): WorkspaceAgentRuntime {
  return {
    documents:
      input.documents ??
      ({
        close: vi.fn(),
        document: vi.fn(async (path: string) => fakeDocument(path, input.files[path]!)),
      } satisfies WorkspaceDocuments),
    identity: { id: "local:test", kind: "local", name: "Test" },
    tree: input.tree ?? flatTreePort(Object.keys(input.files)),
  };
}

function fakeDocument(path: string, value: string) {
  return { path, read: () => value } as WorkspaceCollaborativeDocument;
}

function flatTreePort(paths: string[]): WorkspaceTreePort {
  let directories = new Map<string, MarkdownTreeNode[]>([["", []]]);
  for (let path of paths) {
    let segments = path.split("/");
    let name = segments.pop()!;
    let parent = "";
    for (let segment of segments) {
      let directoryPath = parent ? `${parent}/${segment}` : segment;
      directories.set(directoryPath, directories.get(directoryPath) ?? []);
      let children = directories.get(parent)!;
      if (!children.some((child) => child.kind == "directory" && child.path == directoryPath)) {
        children.push(directory(directoryPath, segment, directories.get(directoryPath)!));
      }
      parent = directoryPath;
    }
    directories.get(parent)!.push({ kind: "file", name, path });
  }
  return treePort(
    [...directories].map(([path, children]) =>
      directory(path, path.split("/").at(-1) ?? "Test", children),
    ),
  );
}

function treePort(nodes: MarkdownDirectoryNode[]): WorkspaceTreePort {
  let byPath = new Map<string, MarkdownDirectoryNode>();
  let visit = (node: MarkdownDirectoryNode) => {
    byPath.set(node.path, node);
    for (let child of node.children) if (child.kind == "directory") visit(child);
  };
  for (let node of nodes) visit(node);
  let root = byPath.get("")!;
  return {
    listEntries: vi.fn(async () => []),
    readDirectory: vi.fn(async (path) => byPath.get(path) ?? directory(path, path, [])),
    readTree: vi.fn(async () => root),
  };
}

function directory(
  path: string,
  name: string,
  children: MarkdownTreeNode[],
): MarkdownDirectoryNode {
  return { children, childrenLoaded: true, kind: "directory", name, path };
}

function file(path: string): MarkdownTreeNode {
  return { kind: "file", name: path.split("/").at(-1)!, path };
}
