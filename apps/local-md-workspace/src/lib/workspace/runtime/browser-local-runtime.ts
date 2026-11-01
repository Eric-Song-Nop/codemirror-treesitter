import {
  defaultOpendalBrowserRuntimeOptions,
  openOpendalBrowserOperator,
  type CreateOpendalBrowserOperatorOptions,
} from "@codemirror-treesitter/opendal-wasm-browser";
import { findWorkspaceFilePathForHandle, type AccessDirectoryHandle } from "../file-system.ts";
import { StaticOpendalOperatorHost } from "../storage/opendal-operator-host.ts";
import { OpendalWorkspaceObjectStore } from "../storage/opendal-workspace-object-store.ts";
import { legacyLocalWorkspaceId, localWorkspaceSourceAliases } from "../source-identity.ts";
import { DefaultWorkspaceDocuments } from "../documents/workspace-documents.ts";
import { WorkspaceDocumentChangeMonitor } from "./document-changes.ts";
import { FileSystemPermissionTracker, PermissionAwareOperatorHost } from "./local-permission.ts";
import { createWorkspaceRuntimeDisposal } from "./runtime-disposal.ts";
import {
  OpendalWorkspaceAssetService,
  OpendalWorkspaceDocumentService,
  OpendalWorkspaceEntryService,
  OpendalWorkspaceTreeService,
} from "./services.ts";
import type { WorkspaceIdentity, WorkspaceRuntime } from "./types.ts";

export async function createBrowserLocalWorkspaceRuntime(input: {
  handle: AccessDirectoryHandle;
  runtimeOptions?: CreateOpendalBrowserOperatorOptions;
  workspaceId?: string;
}): Promise<WorkspaceRuntime> {
  let identity: WorkspaceIdentity = {
    id: input.workspaceId ?? legacyLocalWorkspaceId(input.handle.name),
    kind: "local",
    name: input.handle.name || "Workspace",
  };
  identity.sourceAliases = localWorkspaceSourceAliases(input.handle.name, identity.id);

  let operator = await openOpendalBrowserOperator(
    {
      kind: "browser-local",
      rootHandle: input.handle as FileSystemDirectoryHandle,
    },
    input.runtimeOptions ?? defaultOpendalBrowserRuntimeOptions(),
  );
  let permission = new FileSystemPermissionTracker(input.handle);
  void permission.check();
  let host = new PermissionAwareOperatorHost(
    new StaticOpendalOperatorHost(identity, operator),
    permission,
  );
  let store = new OpendalWorkspaceObjectStore(host);
  let documentSource = new OpendalWorkspaceDocumentService(store);
  let documentChanges = new WorkspaceDocumentChangeMonitor({
    localRoot: input.handle,
    observe: (path) => documentSource.observe(path),
    probe: (path) => store.probe(path),
  });
  let documents = new DefaultWorkspaceDocuments({
    changes: documentChanges,
    documentSource,
    identity,
  });
  let dispose = createWorkspaceRuntimeDisposal({
    changes: documentChanges,
    documents,
    host,
  });

  return {
    assets: new OpendalWorkspaceAssetService(store),
    documentChanges,
    documentSource,
    dispose,
    documents,
    entries: new OpendalWorkspaceEntryService(store),
    host: {
      findFilePathForHandle: (handle) => findWorkspaceFilePathForHandle(input.handle, handle),
      permission,
      queryPermission: () => permission.check(),
    },
    identity,
    tree: new OpendalWorkspaceTreeService(store, identity.name),
  };
}
