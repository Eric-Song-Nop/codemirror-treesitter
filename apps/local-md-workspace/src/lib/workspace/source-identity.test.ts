import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceStorageKind } from "@/lib/storage/types";
import type { WorkspaceIdentity } from "@/lib/workspace-runtime/types";
import {
  collabBroadcastChannelName,
  documentSourceAliasRefs,
  documentSourceDocumentIdInput,
  documentSourceKey,
  documentSourceRef,
  legacyLocalWorkspaceId,
  localWorkspaceSourceAliases,
  sameDocumentSourceRef,
  workspaceNamespace,
  workspaceCanHostOwnerShare,
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

  it("keeps owner-share policy on workspace identity", () => {
    expect(workspaceCanHostOwnerShare(fakeBackend("opendal-gdrive", "gdrive:workspace-1"))).toBe(
      true,
    );
    expect(workspaceCanHostOwnerShare(fakeBackend("opendal-s3", "s3:workspace-1"))).toBe(false);
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

  it("derives explicit local source aliases for migrated workspace handles", () => {
    let aliases = localWorkspaceSourceAliases("Notes", "local:workspace-2");
    let backend = fakeBackend("local", "local:workspace-2", "Notes", aliases);
    let currentRef = documentSourceRef(backend, "daily.md");
    let [aliasRef] = documentSourceAliasRefs(backend, "daily.md");

    expect(legacyLocalWorkspaceId("Notes")).toBe("local:Notes");
    expect(aliases).toEqual([
      {
        kind: "local",
        namespace: "local:local:Notes",
        workspaceId: "local:Notes",
      },
    ]);
    expect(aliasRef).toEqual({
      backendKind: "local",
      path: "daily.md",
      workspaceId: "local:Notes",
      workspaceNamespace: "local:local:Notes",
    });
    expect(sameDocumentSourceRef(aliasRef, currentRef)).toBe(false);
  });

  it("omits a local alias when the current workspace already uses the legacy id", () => {
    expect(localWorkspaceSourceAliases("Notes", "local:Notes")).toEqual([]);
  });
});

function fakeBackend(
  kind: WorkspaceStorageKind,
  id: string,
  name = "Workspace",
  sourceAliases: WorkspaceIdentity["sourceAliases"] = [],
): WorkspaceIdentity {
  return {
    id,
    kind,
    name,
    sourceAliases,
  };
}
