import { describe, expect, it, vi } from "vite-plus/test";
import type { EditorView } from "@codemirror/view";
import type { MarkdownDirectoryNode, MarkdownTreeNode } from "../../../workspace/tree.ts";
import type {
  WorkspaceDocumentPort,
  WorkspaceTreePort,
  WorkspaceTextSnapshot,
} from "../../../workspace/runtime/types.ts";
import type { SourceObservation } from "../../../workspace/storage/types.ts";
import type { WorkspaceAgentReadRuntime } from "../../application/workspace-search.ts";
import type { WorkspaceAgentActiveEditorCapability } from "./active-editor.ts";
import { createWorkspaceAgentHost } from "./host.ts";

describe("workspace agent read host", () => {
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
    let runtime = fakeRuntime({ files: { "A.md": "uppercase", "a.md": "lowercase" } });
    let host = createWorkspaceAgentHost({
      limits: { list: { defaultPageSize: 1 } },
      runtime,
    });

    let first = await host.listMarkdown();
    let second = await host.listMarkdown({ cursor: first.nextCursor });

    expect([...first.files, ...second.files].map((file) => file.path)).toEqual(["A.md", "a.md"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("reads and searches the active dirty value instead of the persisted source", async () => {
    let values = { "draft.md": "persisted needle", "other.md": "Needle elsewhere" };
    let observe = vi.fn(async (path: string) =>
      observation(path, values[path as keyof typeof values]),
    );
    let runtime = fakeRuntime({
      documents: { commit: vi.fn(), observe } satisfies WorkspaceDocumentPort,
      files: { "draft.md": "persisted needle", "other.md": "Needle elsewhere" },
    });
    let host = createWorkspaceAgentHost({
      activeEditor: readOnlyActiveEditor("# Draft\nunsaved Needle"),
      runtime,
    });

    await expect(host.readMarkdown({ path: "draft.md" })).resolves.toMatchObject({
      source: {
        dirty: true,
        kind: "active-document",
        version: {
          documentGeneration: 1,
          documentId: "doc:draft.md",
          editVersion: 7,
          path: "draft.md",
          targetGeneration: 1,
          version: 1,
          workspaceId: "local:test",
        },
      },
      status: "found",
      text: "# Draft\nunsaved Needle",
    });
    let search = await host.searchMarkdown({ query: "needle" });
    expect(search).toMatchObject({
      matches: [
        { line: 2, path: "draft.md", preview: "unsaved Needle" },
        { line: 1, path: "other.md", preview: "Needle elsewhere" },
      ],
      status: "complete",
    });
    expect(observe).not.toHaveBeenCalledWith("draft.md");
  });

  it("never reads a Markdown-looking path that the filtered tree does not expose", async () => {
    let observe = vi.fn(async () => observation(".git/private.md", "secret"));
    let runtime = fakeRuntime({
      documents: { commit: vi.fn(), observe } satisfies WorkspaceDocumentPort,
      files: { "public.md": "public" },
    });
    let host = createWorkspaceAgentHost({ runtime });

    await expect(host.readMarkdown({ path: ".git/private.md" })).resolves.toEqual({
      path: ".git/private.md",
      reason: "outside-workspace",
      status: "not-found",
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("reports search limits and responds to AbortSignal", async () => {
    let runtime = fakeRuntime({ files: { "a.md": "hit hit", "b.md": "hit" } });
    let host = createWorkspaceAgentHost({
      limits: { search: { maxMatches: 2 } },
      runtime,
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

  it("skips known oversized search files before reading their contents", async () => {
    let observe = vi.fn(async () => observation("large.md", "oversized hit"));
    let runtime = fakeRuntime({
      documents: { commit: vi.fn(), observe } satisfies WorkspaceDocumentPort,
      files: { "large.md": "oversized hit" },
    });
    runtime.entries = {
      probe: vi.fn(async () => ({
        state: "present" as const,
        value: { kind: "file" as const, metadata: { size: 1_000 } },
      })),
    };
    let host = createWorkspaceAgentHost({
      limits: { search: { maxFileBytes: 8 } },
      runtime,
    });

    await expect(host.searchMarkdown({ query: "hit" })).resolves.toMatchObject({
      readBytes: 0,
      skippedLargeFiles: 1,
      status: "truncated",
      truncationReason: "max-file-bytes",
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("keeps the active document inside the search file budget", async () => {
    let runtime = fakeRuntime({ files: { "other.md": "persisted hit" } });
    let host = createWorkspaceAgentHost({
      activeEditor: readOnlyActiveEditor("active hit"),
      limits: { search: { maxFiles: 1 } },
      runtime,
    });

    await expect(host.searchMarkdown({ query: "hit" })).resolves.toMatchObject({
      matches: [{ path: "draft.md" }],
      scannedFiles: 1,
    });
  });

  it("advertises edits only while a matching active document is captured", () => {
    let runtime = fakeRuntime({ files: {} });
    let host = createWorkspaceAgentHost({
      activeEditor: { getActiveEditor: () => null },
      runtime,
    });

    expect(host.getContext().capabilities.applyCurrentDocumentEdits).toBe(false);
  });

  it("bounds read output by lines and bytes while preserving source metadata", async () => {
    let runtime = fakeRuntime({ files: { "long.md": "one\ntwo\nthree" } });
    let host = createWorkspaceAgentHost({
      limits: { read: { maxBytes: 8, maxLines: 2 } },
      runtime,
    });

    await expect(host.readMarkdown({ lineCount: 10, path: "long.md" })).resolves.toMatchObject({
      endLine: 2,
      source: { contentHash: "hash:long.md", kind: "workspace-source" },
      startLine: 1,
      status: "found",
      text: "one\ntwo\n",
      totalLines: 3,
      truncated: true,
    });
  });

  it("can page to an empty final line", async () => {
    let runtime = fakeRuntime({ files: { "trailing.md": "one\n" } });
    let host = createWorkspaceAgentHost({ runtime });

    await expect(host.readMarkdown({ path: "trailing.md", startLine: 2 })).resolves.toMatchObject({
      endLine: 2,
      startLine: 2,
      status: "found",
      text: "",
      totalLines: 2,
      truncated: false,
    });
  });
});

function fakeRuntime(input: {
  documents?: WorkspaceDocumentPort;
  files: Record<string, string>;
  tree?: WorkspaceTreePort;
}): WorkspaceAgentReadRuntime {
  let documents =
    input.documents ??
    ({
      commit: vi.fn(),
      observe: vi.fn(async (path: string) =>
        path in input.files ? observation(path, input.files[path]!) : { state: "missing" as const },
      ),
    } satisfies WorkspaceDocumentPort);
  return {
    documents,
    identity: { id: "local:test", kind: "local", name: "Test" },
    tree: input.tree ?? flatTreePort(Object.keys(input.files)),
  };
}

function flatTreePort(paths: string[]): WorkspaceTreePort {
  let directories = new Map<string, MarkdownTreeNode[]>();
  directories.set("", []);
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
  let nodes = [...directories].map(([path, children]) =>
    directory(path, path.split("/").at(-1) ?? "Test", children),
  );
  return treePort(nodes);
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
    readDirectory: vi.fn(async (path) => byPath.get(path) ?? missingDirectory(path)),
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

function missingDirectory(path: string): MarkdownDirectoryNode {
  return directory(path, path.split("/").at(-1) ?? "", []);
}

function file(path: string): MarkdownTreeNode {
  return { kind: "file", name: path.split("/").at(-1)!, path };
}

function observation(path: string, value: string): SourceObservation<WorkspaceTextSnapshot> {
  return {
    state: "present",
    value: {
      bytes: new TextEncoder().encode(value),
      capture: "bound",
      contentHash: `hash:${path}`,
      metadata: {},
      revision: { kind: "etag", validation: "atomic", value: `revision:${path}` },
      value,
    },
  };
}

function readOnlyActiveEditor(value: string): WorkspaceAgentActiveEditorCapability {
  return {
    getActiveEditor: () => ({
      documentGeneration: 1,
      documentId: "doc:draft.md",
      dirty: true,
      editVersion: 7,
      path: "draft.md",
      targetGeneration: 1,
      value,
      view: {
        state: { doc: { toString: () => value } },
      } as EditorView,
      workspaceId: "local:test",
    }),
  };
}
