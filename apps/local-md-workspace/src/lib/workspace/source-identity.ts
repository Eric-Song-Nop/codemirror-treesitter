import type { WorkspaceStorageKind } from "@/lib/workspace/storage/types";
import type { WorkspaceIdentity } from "@/lib/workspace/runtime/types";

export type WorkspaceSourceAlias = NonNullable<WorkspaceIdentity["sourceAliases"]>[number];
export type WorkspaceSourceRevision = {
  etag?: string;
  version?: string;
};

export type WorkspaceSourceIdentity = {
  displayName: string;
  kind: WorkspaceStorageKind;
  namespace: string;
  workspaceId: string;
};

export type WorkspaceIdentitySource = WorkspaceIdentity;

export type DocumentSourceRef = {
  backendKind: WorkspaceStorageKind;
  fileId?: string;
  path: string;
  revision?: WorkspaceSourceRevision;
  workspaceId: string;
  workspaceNamespace: string;
};

export type DocumentSourceRefExtra = {
  fileId?: string;
  revision?: WorkspaceSourceRevision;
};

export function workspaceSourceIdentity(
  identity: WorkspaceIdentitySource,
): WorkspaceSourceIdentity {
  return {
    displayName: identity.name,
    kind: identity.kind,
    namespace: workspaceNamespace(identity),
    workspaceId: identity.id,
  };
}

export function workspaceNamespace(source: WorkspaceIdentitySource | WorkspaceSourceIdentity) {
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

export function workspaceSourceAliases(identity: WorkspaceIdentitySource): WorkspaceSourceAlias[] {
  let currentNamespace = workspaceNamespace(identity);
  let seen = new Set([currentNamespace]);
  let aliases: WorkspaceSourceAlias[] = [];

  for (let alias of identity.sourceAliases ?? []) {
    if (alias.kind != identity.kind) continue;
    if (!alias.namespace || !alias.workspaceId || seen.has(alias.namespace)) continue;
    seen.add(alias.namespace);
    aliases.push(alias);
  }

  return aliases;
}

export function workspaceCanHostOwnerShare(identity: WorkspaceIdentitySource) {
  return identity.kind != "opendal-s3";
}

export function documentSourceRef(
  identity: WorkspaceIdentitySource,
  path: string,
  extra: DocumentSourceRefExtra = {},
): DocumentSourceRef {
  return documentSourceRefForWorkspaceSource(
    {
      kind: identity.kind,
      namespace: workspaceNamespace(identity),
      workspaceId: identity.id,
    },
    path,
    extra,
  );
}

export function documentSourceAliasRefs(
  identity: WorkspaceIdentitySource,
  path: string,
  extra: DocumentSourceRefExtra = {},
): DocumentSourceRef[] {
  return workspaceSourceAliases(identity).map((alias) =>
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
  source: WorkspaceIdentitySource | WorkspaceSourceIdentity | DocumentSourceRef,
  docId: string,
) {
  return `local-md-workspace:${sourceWorkspaceNamespace(source)}:doc:${docId}`;
}

function normalizeSourcePath(path: string) {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function workspaceNamespaceFromParts(kind: WorkspaceStorageKind, workspaceId: string) {
  return `${kind}:${workspaceId}`;
}

function encodeKeyPart(value: string) {
  return encodeURIComponent(value);
}

function sourceWorkspaceNamespace(
  source: WorkspaceIdentitySource | WorkspaceSourceIdentity | DocumentSourceRef,
) {
  if ("workspaceNamespace" in source) return source.workspaceNamespace;
  return workspaceNamespace(source);
}
