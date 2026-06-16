import type {
  WorkspaceBackend,
  WorkspaceBackendKind,
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
  return `${source.kind}:${source.id}`;
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
  return {
    backendKind: backend.kind,
    fileId: extra.fileId,
    path: normalizeSourcePath(path),
    revision: extra.revision,
    workspaceId: backend.id,
    workspaceNamespace: workspaceNamespace(backend),
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

function encodeKeyPart(value: string) {
  return encodeURIComponent(value);
}

function sourceWorkspaceNamespace(
  source: WorkspaceBackend | WorkspaceSourceIdentity | DocumentSourceRef,
) {
  if ("workspaceNamespace" in source) return source.workspaceNamespace;
  return workspaceNamespace(source);
}
