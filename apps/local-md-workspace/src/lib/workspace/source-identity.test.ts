import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceBackend, WorkspaceBackendKind } from "@/lib/workspace-backend";
import {
  collabBroadcastChannelName,
  documentSourceDocumentIdInput,
  documentSourceKey,
  documentSourceRef,
  workspaceNamespace,
  workspaceSourceCapabilities,
  workspaceSourceIdentity,
} from "./source-identity.ts";

describe("workspace source identity", () => {
  it("isolates local and Google Drive sources with the same path", () => {
    let localRef = documentSourceRef(fakeBackend("local", "local:workspace-1"), "notes/daily.md");
    let gdriveRef = documentSourceRef(
      fakeBackend("opendal-gdrive", "gdrive:workspace-1"),
      "notes/daily.md",
    );

    expect(documentSourceKey(localRef)).not.toBe(documentSourceKey(gdriveRef));
    expect(documentSourceDocumentIdInput(localRef)).not.toBe(
      documentSourceDocumentIdInput(gdriveRef),
    );
    expect(collabBroadcastChannelName(localRef, "doc-abc")).not.toBe(
      collabBroadcastChannelName(gdriveRef, "doc-abc"),
    );
  });

  it("keeps source identity stable for the same backend and path", () => {
    let backend = fakeBackend("opendal-gdrive", "gdrive:workspace-1", "Google Drive");
    let firstRef = documentSourceRef(backend, "/notes//daily.md");
    let secondRef = documentSourceRef(backend, "notes/daily.md");

    expect(workspaceSourceIdentity(backend)).toEqual({
      displayName: "Google Drive",
      kind: "opendal-gdrive",
      namespace: "opendal-gdrive:gdrive:workspace-1",
      workspaceId: "gdrive:workspace-1",
    });
    expect(workspaceNamespace(backend)).toBe("opendal-gdrive:gdrive:workspace-1");
    expect(workspaceNamespace(workspaceSourceIdentity(backend))).toBe(
      "opendal-gdrive:gdrive:workspace-1",
    );
    expect(firstRef).toEqual(secondRef);
    expect(documentSourceKey(firstRef)).toBe(documentSourceKey(secondRef));
    expect(documentSourceDocumentIdInput(firstRef)).toBe(
      "opendal-gdrive:gdrive:workspace-1:notes/daily.md",
    );
    expect(collabBroadcastChannelName(firstRef, "doc-abc")).toBe(
      "local-md-workspace:opendal-gdrive:gdrive:workspace-1:doc:doc-abc",
    );
  });

  it("marks remote source capabilities without treating share as a backend", () => {
    let gdrive = workspaceSourceCapabilities(fakeBackend("opendal-gdrive", "gdrive:workspace-1"));
    let s3 = workspaceSourceCapabilities(fakeBackend("opendal-s3", "s3:workspace-1"));

    expect(gdrive).toMatchObject({
      canHostOwnerShare: true,
      canWrite: true,
      isRemote: true,
      supportsConditionalWrite: false,
      supportsRevision: false,
      supportsStableFileId: false,
      supportsStat: true,
    });
    expect(s3).toMatchObject({
      canHostOwnerShare: false,
      canWrite: false,
      isRemote: true,
    });
  });

  it("carries optional source revision and file id metadata", () => {
    let ref = documentSourceRef(
      fakeBackend("opendal-onedrive", "onedrive:workspace-1"),
      "daily.md",
      {
        fileId: "file-123",
        revision: { etag: "etag-1", version: "v1" },
      },
    );

    expect(ref).toMatchObject({
      backendKind: "opendal-onedrive",
      fileId: "file-123",
      path: "daily.md",
      revision: { etag: "etag-1", version: "v1" },
      workspaceId: "onedrive:workspace-1",
      workspaceNamespace: "opendal-onedrive:onedrive:workspace-1",
    });
    expect(documentSourceKey(ref)).toContain("file");
    expect(documentSourceKey(ref)).toContain("file-123");
  });
});

function fakeBackend(kind: WorkspaceBackendKind, id: string, name = "Workspace"): WorkspaceBackend {
  return {
    id,
    kind,
    name,
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
    stat: async (path) => ({
      exists: true,
      isDirectory: false,
      isFile: true,
      path,
    }),
    writeFile: async () => {},
  };
}
