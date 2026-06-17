import { describe, expect, it } from "vite-plus/test";
import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import type { WorkspaceBackend, WorkspaceBackendKind } from "@/lib/workspace-backend";
import { createDocumentSession, documentSessionMatchesSource } from "./document-session.ts";
import { documentSourceRef } from "./source-identity.ts";

describe("document sessions", () => {
  it("binds a collab document to a concrete workspace source", () => {
    let backend = fakeBackend("opendal-gdrive", "gdrive:workspace-1");
    let file = { kind: "file" as const, name: "note.md", path: "notes/note.md" };
    let session = createDocumentSession(backend, file, fakeCollabDocument("notes/note.md"));

    expect(session.id).toBe("opendal-gdrive:gdrive:workspace-1:notes/note.md");
    expect(session.sourceRef).toEqual({
      backendKind: "opendal-gdrive",
      path: "notes/note.md",
      workspaceId: "gdrive:workspace-1",
      workspaceNamespace: "opendal-gdrive:gdrive:workspace-1",
    });
    expect(documentSessionMatchesSource(session, documentSourceRef(backend, file.path))).toBe(true);
    expect(
      documentSessionMatchesSource(
        session,
        documentSourceRef(fakeBackend("local", "local:workspace-1"), file.path),
      ),
    ).toBe(false);
  });
});

function fakeBackend(kind: WorkspaceBackendKind, id: string): WorkspaceBackend {
  return {
    id,
    kind,
    name: "Workspace",
    createFile: async () => null,
    deleteFile: async () => {},
    readFile: async () => "",
    readTree: async () => ({
      children: [],
      kind: "directory",
      name: "Workspace",
      path: "",
    }),
    renameFile: async (_path, rawName) => rawName,
    writeFile: async () => {},
  };
}

function fakeCollabDocument(path: string) {
  return { path } as CollabDocumentState;
}
