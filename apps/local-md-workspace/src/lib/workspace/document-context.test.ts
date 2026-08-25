import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceCollaborativeDocument } from "@/lib/workspace/documents";
import type { WorkspaceStorageKind } from "@/lib/workspace/storage/types";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";
import {
  createWorkspaceDocumentContext,
  workspaceDocumentContextMatchesSource,
} from "./document-context.ts";
import { documentSourceRef } from "./source-identity.ts";

describe("workspace document contexts", () => {
  it("binds a collab document to a concrete workspace source", () => {
    let runtime = fakeRuntime("opendal-gdrive", "gdrive:workspace-1");
    let file = { kind: "file" as const, name: "note.md", path: "notes/note.md" };
    let context = createWorkspaceDocumentContext(
      runtime,
      file,
      fakeCollabDocument("notes/note.md"),
    );

    expect(context.id).toBe("opendal-gdrive:gdrive:workspace-1:notes/note.md");
    expect(context.sourceRef).toEqual({
      backendKind: "opendal-gdrive",
      path: "notes/note.md",
      workspaceId: "gdrive:workspace-1",
      workspaceNamespace: "opendal-gdrive:gdrive:workspace-1",
    });
    expect(
      workspaceDocumentContextMatchesSource(
        context,
        documentSourceRef(runtime.identity, file.path),
      ),
    ).toBe(true);
    expect(
      workspaceDocumentContextMatchesSource(
        context,
        documentSourceRef(fakeRuntime("local", "local:workspace-1").identity, file.path),
      ),
    ).toBe(false);
  });
});

function fakeRuntime(kind: WorkspaceStorageKind, id: string): WorkspaceRuntime {
  return {
    identity: { id, kind, name: "Workspace" },
  } as WorkspaceRuntime;
}

function fakeCollabDocument(path: string) {
  return { path } as WorkspaceCollaborativeDocument;
}
