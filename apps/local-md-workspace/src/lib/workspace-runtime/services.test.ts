import { describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceObjectStore } from "../storage/types.ts";
import {
  OpendalWorkspaceAssetService,
  OpendalWorkspaceDocumentService,
  OpendalWorkspaceEntryService,
  OpendalWorkspaceTreeService,
} from "./services.ts";

describe("OpenDAL workspace product services", () => {
  it("builds a lazy Markdown tree while hiding internal and ignored entries", async () => {
    let store = objectStore({
      listDirectory: vi.fn(async () => [
        entry(".git/", "directory"),
        entry(".livemd/", "directory"),
        entry("notes/", "directory"),
        entry("README.md", "file"),
        entry("draft.markdown", "file"),
        entry("image.png", "file"),
      ]),
    });

    await expect(new OpendalWorkspaceTreeService(store, "Notes").readTree()).resolves.toEqual({
      children: [
        { children: [], childrenLoaded: false, kind: "directory", name: "notes", path: "notes" },
        { kind: "file", name: "README.md", path: "README.md" },
      ],
      childrenLoaded: true,
      kind: "directory",
      name: "Notes",
      path: "",
    });
  });

  it("creates Markdown files with no-clobber intent and starter content", async () => {
    let commit = vi.fn(async () => ({
      revision: { kind: "etag" as const, validation: "atomic" as const, value: "r1" },
      status: "committed" as const,
    }));
    let service = new OpendalWorkspaceEntryService(objectStore({ commit }));

    await expect(service.create("notes/project plan")).resolves.toBe("notes/project plan.md");
    expect(commit).toHaveBeenCalledWith({
      bytes: new TextEncoder().encode("# project plan\n"),
      condition: { kind: "if-absent" },
      path: "notes/project plan.md",
    });
  });

  it("preserves explicit document observations and commit conditions", async () => {
    let read = vi.fn(async () => ({
      state: "present" as const,
      value: {
        bytes: new TextEncoder().encode("# Note\n"),
        capture: "bound" as const,
        contentHash: "sha256:note",
        metadata: { etag: "r1" },
        revision: { kind: "etag" as const, validation: "atomic" as const, value: "r1" },
      },
    }));
    let commit = vi.fn(async () => ({
      revision: { kind: "etag" as const, validation: "atomic" as const, value: "r2" },
      status: "committed" as const,
    }));
    let service = new OpendalWorkspaceDocumentService(objectStore({ commit, read }));

    await expect(service.observe("note.md")).resolves.toMatchObject({
      state: "present",
      value: { revision: { value: "r1" }, value: "# Note\n" },
    });
    await service.commit({
      condition: {
        kind: "if-unchanged",
        revision: { kind: "etag", validation: "atomic", value: "r1" },
      },
      path: "note.md",
      value: "# Updated\n",
    });
    expect(commit).toHaveBeenCalledWith({
      bytes: new TextEncoder().encode("# Updated\n"),
      condition: {
        kind: "if-unchanged",
        revision: { kind: "etag", validation: "atomic", value: "r1" },
      },
      path: "note.md",
    });
  });

  it("allocates a non-clobbering image name through the same object store", async () => {
    let commit = vi
      .fn()
      .mockResolvedValueOnce({ status: "conflict" })
      .mockResolvedValueOnce({
        revision: { kind: "etag", validation: "atomic", value: "r2" },
        status: "committed",
      });
    let createDirectory = vi.fn(async () => ({ status: "applied" as const }));
    let service = new OpendalWorkspaceAssetService(objectStore({ commit, createDirectory }));
    let file = new File([new Uint8Array([1, 2, 3])], "Screen Shot.PNG", {
      type: "image/png",
    });

    await expect(service.create("notes/note.md", file)).resolves.toMatchObject({
      markdownReference: "assets/screen-shot-2.png",
      path: "notes/assets/screen-shot-2.png",
    });
    expect(createDirectory).toHaveBeenCalledWith("notes/assets", { kind: "unconditional" });
    expect(commit.mock.calls.map(([request]) => request.path)).toEqual([
      "notes/assets/screen-shot.png",
      "notes/assets/screen-shot-2.png",
    ]);
  });
});

function objectStore(overrides: Partial<WorkspaceObjectStore> = {}): WorkspaceObjectStore {
  return {
    capabilities: {
      commit: { ifAbsent: "atomic", ifUnchanged: "atomic" },
      createDirectory: { ifAbsent: "observed", supported: true },
      delete: { ifUnchanged: "observed", recursive: "native", single: true },
      move: {
        directory: "native",
        file: "native",
        sourceIfUnchanged: "observed",
        targetIfAbsent: "observed",
      },
    },
    commit: async () => ({
      revision: { kind: "etag", validation: "atomic", value: "revision" },
      status: "committed",
    }),
    createDirectory: async () => ({ status: "applied" }),
    delete: async () => ({ status: "applied" }),
    id: "workspace",
    listDirectory: async () => [],
    move: async () => ({ status: "applied" }),
    probe: async () => ({ state: "missing" }),
    read: async () => ({ state: "missing" }),
    ...overrides,
  };
}

function entry(path: string, kind: "directory" | "file") {
  return { kind, metadata: {}, path };
}
