import type {
  WorkspaceBackend,
  WorkspaceBackendKind,
  WorkspaceSourceAlias,
  WorkspaceSourceRevision,
} from "@/lib/workspace-backend";

export type WorkspaceSourceIdentity = {
  displayName: string;
  kind: WorkspaceBackendKind;
  namespace: string;
  workspaceId: string;
};

export type DocumentSourceRef = {
  backendKind: WorkspaceBackendKind;
  fileId?: string;
  path: string;
  revision?: WorkspaceSourceRevision;
  workspaceId: string;
  workspaceNamespace: string;
};

export type WorkspaceSourceCapabilities = {
  canHostOwnerShare: boolean;
  canWrite: boolean;
  isRemote: boolean;
  supportsConditionalWrite: boolean;
  supportsRevision: boolean;
  supportsStableFileId: boolean;
  supportsStat: boolean;
};

export type DocumentSourceRefExtra = {
  fileId?: string;
  revision?: WorkspaceSourceRevision;
};

export function workspaceSourceIdentity(backend: WorkspaceBackend): WorkspaceSourceIdentity {
  return {
    displayName: backend.name,
    kind: backend.kind,
    namespace: workspaceNamespace(backend),
    workspaceId: backend.id,
  };
}

export function workspaceNamespace(source: WorkspaceBackend | WorkspaceSourceIdentity) {
  if ("namespace" in source) return source.namespace;
  return workspaceNamespaceFromParts(source.kind, source.id);
}

export function legacyLocalWorkspaceId(name: string) {
  return `local:${name || "workspace"}`;
}

export function localWorkspaceSourceAliases(
  name: string,
  currentWorkspaceId: string,
): WorkspaceSourceAlias[] {
  let workspaceId = legacyLocalWorkspaceId(name);
  let alias: WorkspaceSourceAlias = {
    kind: "local",
    namespace: workspaceNamespaceFromParts("local", workspaceId),
    workspaceId,
  };

  return alias.namespace == workspaceNamespaceFromParts("local", currentWorkspaceId) ? [] : [alias];
}

export function workspaceSourceAliases(backend: WorkspaceBackend): WorkspaceSourceAlias[] {
  let currentNamespace = workspaceNamespace(backend);
  let seen = new Set([currentNamespace]);
  let aliases: WorkspaceSourceAlias[] = [];

  for (let alias of backend.sourceAliases ?? []) {
    if (alias.kind != backend.kind) continue;
    if (!alias.namespace || !alias.workspaceId || seen.has(alias.namespace)) continue;
    seen.add(alias.namespace);
    aliases.push(alias);
  }

  return aliases;
}

export function workspaceSourceCapabilities(
  backend: WorkspaceBackend,
): WorkspaceSourceCapabilities {
  let canWrite = isWritableSourceKind(backend.kind) && typeof backend.writeFile == "function";
  let isRemote = isRemoteSourceKind(backend.kind);
  let supportsStat = typeof backend.stat == "function";

  return {
    canHostOwnerShare: canWrite && canOwnerHostShareKind(backend.kind),
    canWrite,
    isRemote,
    supportsConditionalWrite: supportsConditionalWriteKind(backend.kind),
    supportsRevision: supportsStat && supportsRevisionKind(backend.kind),
    supportsStableFileId: supportsStableFileIdKind(backend.kind),
    supportsStat,
  };
}

export function documentSourceRef(
  backend: WorkspaceBackend,
  path: string,
  extra: DocumentSourceRefExtra = {},
): DocumentSourceRef {
  return documentSourceRefForWorkspaceSource(
    {
      kind: backend.kind,
      namespace: workspaceNamespace(backend),
      workspaceId: backend.id,
    },
    path,
    extra,
  );
}

export function documentSourceAliasRefs(
  backend: WorkspaceBackend,
  path: string,
  extra: DocumentSourceRefExtra = {},
): DocumentSourceRef[] {
  return workspaceSourceAliases(backend).map((alias) =>
    documentSourceRefForWorkspaceSource(alias, path, extra),
  );
}

function documentSourceRefForWorkspaceSource(
  source: WorkspaceSourceAlias,
  path: string,
  extra: DocumentSourceRefExtra = {},
): DocumentSourceRef {
  return {
    backendKind: source.kind,
    fileId: extra.fileId,
    path: normalizeSourcePath(path),
    revision: extra.revision,
    workspaceId: source.workspaceId,
    workspaceNamespace: source.namespace,
  };
}

export function documentSourceKey(ref: DocumentSourceRef) {
  return ["workspace", ref.workspaceNamespace, ref.fileId ? "file" : "path", ref.fileId ?? ref.path]
    .map(encodeKeyPart)
    .join(":");
}

export function documentSourceDocumentIdInput(ref: DocumentSourceRef) {
  return `${ref.workspaceNamespace}:${ref.fileId ? `file:${ref.fileId}` : ref.path}`;
}

export function sameDocumentSourceRef(left: DocumentSourceRef, right: DocumentSourceRef) {
  if (left.workspaceNamespace != right.workspaceNamespace) return false;
  if (left.fileId && right.fileId) return left.fileId == right.fileId;
  return left.path == right.path;
}

export function collabBroadcastChannelName(
  source: WorkspaceBackend | WorkspaceSourceIdentity | DocumentSourceRef,
  docId: string,
) {
  return `local-md-workspace:${sourceWorkspaceNamespace(source)}:doc:${docId}`;
}

function isRemoteSourceKind(kind: WorkspaceBackendKind) {
  return kind.startsWith("opendal-");
}

function isWritableSourceKind(kind: WorkspaceBackendKind) {
  return (
    kind == "local" ||
    kind == "opendal-dropbox" ||
    kind == "opendal-gdrive" ||
    kind == "opendal-onedrive"
  );
}

function canOwnerHostShareKind(kind: WorkspaceBackendKind) {
  return isWritableSourceKind(kind);
}

function supportsRevisionKind(kind: WorkspaceBackendKind) {
  return kind == "opendal-dropbox" || kind == "opendal-onedrive";
}

function supportsConditionalWriteKind(kind: WorkspaceBackendKind) {
  return kind == "opendal-onedrive";
}

function supportsStableFileIdKind(_kind: WorkspaceBackendKind) {
  return false;
}

function normalizeSourcePath(path: string) {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function workspaceNamespaceFromParts(kind: WorkspaceBackendKind, workspaceId: string) {
  return `${kind}:${workspaceId}`;
}

function encodeKeyPart(value: string) {
  return encodeURIComponent(value);
}

function sourceWorkspaceNamespace(
  source: WorkspaceBackend | WorkspaceSourceIdentity | DocumentSourceRef,
) {
  if ("workspaceNamespace" in source) return source.workspaceNamespace;
  return workspaceNamespace(source);
}
