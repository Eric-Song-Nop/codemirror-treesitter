import {
  defaultOpendalBrowserRuntimeOptions,
  openOpendalBrowserOperator,
  type CreateOpendalBrowserOperatorOptions,
} from "@codemirror-treesitter/opendal-wasm-browser";
import {
  findWorkspaceFilePathForHandle,
  queryReadWritePermission,
  type AccessDirectoryHandle,
} from "../file-system.ts";
import { StaticOpendalOperatorHost } from "../storage/opendal-operator-host.ts";
import { OpendalWorkspaceObjectStore } from "../storage/opendal-workspace-object-store.ts";
import { legacyLocalWorkspaceId, localWorkspaceSourceAliases } from "../source-identity.ts";
import { DefaultWorkspaceDocuments } from "../documents/workspace-documents.ts";
import { ActiveDocumentChangeSource } from "./current-document-changes.ts";
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
  let host = new StaticOpendalOperatorHost(identity, operator);
  let store = new OpendalWorkspaceObjectStore(host);
  let documentSource = new OpendalWorkspaceDocumentService(store);
  let currentDocumentChanges = new ActiveDocumentChangeSource({
    localRoot: input.handle,
    observe: (path) => documentSource.observe(path),
    probe: (path) => store.probe(path),
  });
  let documents = new DefaultWorkspaceDocuments({
    changes: currentDocumentChanges,
    identity,
    source: documentSource,
  });
  let dispose = createWorkspaceRuntimeDisposal({
    changes: currentDocumentChanges,
    documents,
    host,
  });

  return {
    assets: new OpendalWorkspaceAssetService(store),
    currentDocumentChanges,
    documentSource,
    dispose,
    documents,
    entries: new OpendalWorkspaceEntryService(store),
    host: {
      findFilePathForHandle: (handle) => findWorkspaceFilePathForHandle(input.handle, handle),
      queryPermission: () => queryReadWritePermission(input.handle),
    },
    identity,
    tree: new OpendalWorkspaceTreeService(store, identity.name),
  };
}
