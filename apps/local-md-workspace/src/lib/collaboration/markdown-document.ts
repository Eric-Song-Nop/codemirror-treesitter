import { liveMdLoroCollaboration } from "@codemirror-treesitter/live-md-loro";
import type { Extension } from "@codemirror/state";
import { LoroDoc, UndoManager } from "loro-crdt";
import type { WorkspaceBackend } from "@/lib/workspace-backend";
import {
  appendBrowserCollabUpdates,
  clearBrowserCollabUpdates,
  loadBrowserCollabDocument,
  writeBrowserCollabSnapshot,
  type BrowserCollabDocumentMetadata,
} from "./collab-browser-store.ts";

const textKey = "markdown";
const maxDocumentUpdateLogBytes = 64 * 1024;

export type CollabDocumentState = {
  cleanValue: string;
  doc: LoroDoc;
  docId: string;
  dispose: () => void;
  externalEdit?: CollabExternalEditResolution;
  extensions: Extension[];
  metadata: BrowserCollabDocumentMetadata;
  path: string;
  pendingUpdates: Uint8Array[];
  persistence: Promise<void>;
  undoManager: UndoManager;
  value: string;
};

export type CollabExternalEditResolution =
  | {
      kind: "conflict-copy";
      path: string;
      sourcePath: string;
    }
  | {
      kind: "shared-conflict-copy";
      path: string;
      sourcePath: string;
    }
  | {
      kind: "imported";
      path: string;
    };

export type CollabMaterializationConflict = {
  externalHash: string;
  kind: "external-source-conflict";
  path: string;
  sharedHash: string;
};

type MaterializationConflictDetails = CollabMaterializationConflict & {
  sharedValue: string;
  visibleValue: string;
};

type MaterializeCollabDocumentOptions = {
  conflictStrategy?: "copy-external" | "overwrite-source";
};

type OpenMarkdownCollabDocumentOptions = {
  reconcileExternalEdits?: boolean;
};

export type MaterializeCollabDocumentResult = {
  externalEdit?: CollabExternalEditResolution;
};

export async function openMarkdownCollabDocument(
  backend: WorkspaceBackend,
  path: string,
  options: OpenMarkdownCollabDocumentOptions = {},
): Promise<CollabDocumentState> {
  let docId = await createDocumentId(backend, path);
  let workspaceId = workspaceDocumentNamespace(backend);
  let stored = await loadBrowserCollabDocument(docId);
  let doc = new LoroDoc();
  let externalEdit: CollabExternalEditResolution | undefined;
  let metadata: BrowserCollabDocumentMetadata =
    stored.metadata && stored.metadata.path == path && stored.metadata.workspaceId == workspaceId
      ? stored.metadata
      : { docId, path, workspaceId };

  if (stored.snapshot) {
    doc.import(stored.snapshot);
    if (stored.updates.length) doc.importBatch(stored.updates);
    if (options.reconcileExternalEdits ?? true) {
      let result = await reconcileExternalMarkdownEdit(backend, metadata, doc);
      externalEdit = result.externalEdit;
      metadata = result.metadata;
    }
  } else {
    let initialValue = await backend.readFile(path);
    let text = doc.getText(textKey);
    if (initialValue) text.insert(0, initialValue);
    if (initialValue) doc.commit();
    metadata = {
      ...metadata,
      materializedAt: Date.now(),
      materializedHash: hashMarkdownText(initialValue),
    };
    await compactDocumentSnapshot(metadata, doc);
  }

  let undoManager = new UndoManager(doc, {});
  let value = doc.getText(textKey).toString();
  let pendingUpdates: Uint8Array[] = [];
  let unsubscribeLocalUpdates = doc.subscribeLocalUpdates((bytes) => {
    pendingUpdates.push(new Uint8Array(bytes));
  });

  return {
    cleanValue: value,
    doc,
    docId,
    dispose: unsubscribeLocalUpdates,
    externalEdit,
    extensions: [liveMdLoroCollaboration({ doc, undoManager, text: textKey })],
    metadata,
    path,
    pendingUpdates,
    persistence: Promise.resolve(),
    undoManager,
    value,
  };
}

export function getCollabDocumentValue(state: CollabDocumentState) {
  return state.doc.getText(textKey).toString();
}

export async function saveCollabDocumentSnapshot(
  _backend: WorkspaceBackend,
  state: CollabDocumentState,
) {
  await enqueueDocumentPersistence(state, async () => {
    let updates = state.pendingUpdates.splice(0);
    try {
      await writeBrowserCollabSnapshot(state.metadata, state.doc.export({ mode: "snapshot" }));
    } catch (error) {
      state.pendingUpdates.unshift(...updates);
      throw error;
    }
    await clearBrowserCollabUpdates(state.docId);
  });
}

export async function savePendingCollabDocumentUpdates(
  _backend: WorkspaceBackend,
  state: CollabDocumentState,
) {
  if (!state.pendingUpdates.length) return;

  await enqueueDocumentPersistence(state, async () => {
    if (!state.pendingUpdates.length) return;

    let updates = state.pendingUpdates.splice(0);
    let updateLogBytes: number;
    try {
      updateLogBytes = await appendBrowserCollabUpdates(state.docId, updates);
    } catch (error) {
      state.pendingUpdates.unshift(...updates);
      throw error;
    }

    if (updateLogBytes >= maxDocumentUpdateLogBytes) {
      await compactDocumentSnapshot(state.metadata, state.doc);
    }
  });
}

export async function materializeCollabDocument(
  backend: WorkspaceBackend,
  state: CollabDocumentState,
  options: MaterializeCollabDocumentOptions = {},
): Promise<MaterializeCollabDocumentResult> {
  let value = getCollabDocumentValue(state);
  let conflict = await findMaterializationConflict(backend, state, value);
  let externalEdit: CollabExternalEditResolution | undefined;

  if (conflict && options.conflictStrategy != "overwrite-source") {
    externalEdit = {
      kind: "conflict-copy",
      path: await writeExternalConflictCopy(backend, state.path, conflict.visibleValue),
      sourcePath: state.path,
    };
  }

  await saveCollabDocumentSnapshot(backend, state);
  await backend.writeFile(state.path, value);
  state.metadata = {
    ...state.metadata,
    materializedAt: Date.now(),
    materializedHash: hashMarkdownText(value),
  };
  await writeBrowserCollabSnapshot(state.metadata, state.doc.export({ mode: "snapshot" }));
  state.cleanValue = value;
  state.externalEdit = externalEdit;
  return { externalEdit };
}

export async function detectCollabMaterializationConflict(
  backend: WorkspaceBackend,
  state: CollabDocumentState,
): Promise<CollabMaterializationConflict | null> {
  let conflict = await findMaterializationConflict(backend, state);
  if (!conflict) return null;
  return {
    externalHash: conflict.externalHash,
    kind: conflict.kind,
    path: conflict.path,
    sharedHash: conflict.sharedHash,
  };
}

export async function keepSourceAndWriteSharedConflictCopy(
  backend: WorkspaceBackend,
  state: CollabDocumentState,
): Promise<{ externalEdit: CollabExternalEditResolution; sourceValue: string }> {
  let conflict = await findMaterializationConflict(backend, state);
  let sourceValue = conflict?.visibleValue ?? (await backend.readFile(state.path));
  let sharedValue = conflict?.sharedValue ?? getCollabDocumentValue(state);
  let externalEdit: CollabExternalEditResolution = {
    kind: "shared-conflict-copy",
    path: await writeSharedConflictCopy(backend, state.path, sharedValue),
    sourcePath: state.path,
  };

  replaceMarkdownText(state.doc, sourceValue);
  await saveCollabDocumentSnapshot(backend, state);
  state.metadata = {
    ...state.metadata,
    materializedAt: Date.now(),
    materializedHash: hashMarkdownText(sourceValue),
  };
  await writeBrowserCollabSnapshot(state.metadata, state.doc.export({ mode: "snapshot" }));
  state.cleanValue = sourceValue;
  state.externalEdit = externalEdit;
  state.value = sourceValue;
  return { externalEdit, sourceValue };
}

async function reconcileExternalMarkdownEdit(
  backend: WorkspaceBackend,
  metadata: BrowserCollabDocumentMetadata,
  doc: LoroDoc,
): Promise<{
  externalEdit?: CollabExternalEditResolution;
  metadata: BrowserCollabDocumentMetadata;
}> {
  if (!metadata.materializedHash) {
    let visibleValue = await backend.readFile(metadata.path);
    if (hashMarkdownText(visibleValue) == hashMarkdownText(doc.getText(textKey).toString())) {
      let nextMetadata = {
        ...metadata,
        materializedAt: Date.now(),
        materializedHash: hashMarkdownText(visibleValue),
      };
      await writeBrowserCollabSnapshot(nextMetadata, doc.export({ mode: "snapshot" }));
      return { metadata: nextMetadata };
    }
    return { metadata };
  }

  let visibleValue = await backend.readFile(metadata.path);
  let visibleHash = hashMarkdownText(visibleValue);
  if (visibleHash == metadata.materializedHash) return { metadata };

  let docValue = doc.getText(textKey).toString();
  if (hashMarkdownText(docValue) == metadata.materializedHash) {
    replaceMarkdownText(doc, visibleValue);
    let nextMetadata = {
      ...metadata,
      materializedAt: Date.now(),
      materializedHash: visibleHash,
    };
    await compactDocumentSnapshot(nextMetadata, doc);
    return {
      externalEdit: { kind: "imported", path: metadata.path },
      metadata: nextMetadata,
    };
  }

  return {
    externalEdit: {
      kind: "conflict-copy",
      path: await writeExternalConflictCopy(backend, metadata.path, visibleValue),
      sourcePath: metadata.path,
    },
    metadata,
  };
}

async function findMaterializationConflict(
  backend: WorkspaceBackend,
  state: CollabDocumentState,
  value = getCollabDocumentValue(state),
): Promise<MaterializationConflictDetails | null> {
  let materializedHash = state.metadata.materializedHash;
  if (!materializedHash) return null;

  let visibleValue = await backend.readFile(state.path);
  let externalHash = hashMarkdownText(visibleValue);
  if (externalHash == materializedHash || visibleValue == value) return null;

  return {
    externalHash,
    kind: "external-source-conflict",
    path: state.path,
    sharedHash: hashMarkdownText(value),
    sharedValue: value,
    visibleValue,
  };
}

function enqueueDocumentPersistence(state: CollabDocumentState, operation: () => Promise<void>) {
  let task = state.persistence.catch(() => {}).then(operation);
  state.persistence = task.catch(() => {});
  return task;
}

async function compactDocumentSnapshot(metadata: BrowserCollabDocumentMetadata, doc: LoroDoc) {
  await writeBrowserCollabSnapshot(metadata, doc.export({ mode: "snapshot" }));
  await clearBrowserCollabUpdates(metadata.docId);
}

function replaceMarkdownText(doc: LoroDoc, value: string) {
  let text = doc.getText(textKey);
  let current = text.toString();
  if (current == value) return;

  if (current) text.delete(0, current.length);
  if (value) text.insert(0, value);
  doc.commit();
}

async function writeExternalConflictCopy(backend: WorkspaceBackend, path: string, value: string) {
  return writeConflictCopy(backend, path, value, "external-conflict");
}

async function writeSharedConflictCopy(backend: WorkspaceBackend, path: string, value: string) {
  return writeConflictCopy(backend, path, value, "shared-conflict");
}

async function writeConflictCopy(
  backend: WorkspaceBackend,
  path: string,
  value: string,
  label: "external-conflict" | "shared-conflict",
) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let conflictPath = conflictCopyPath(path, label, Date.now(), attempt);
    if (backend.stat) {
      let stat = await backend.stat(conflictPath);
      if (stat.exists) continue;
    }

    await backend.writeFile(conflictPath, value);
    return conflictPath;
  }

  throw new Error("Could not allocate an external edit conflict file.");
}

function conflictCopyPath(
  path: string,
  label: "external-conflict" | "shared-conflict",
  now: number,
  attempt: number,
) {
  let slash = path.lastIndexOf("/");
  let directory = slash == -1 ? "" : path.slice(0, slash + 1);
  let fileName = slash == -1 ? path : path.slice(slash + 1);
  let extension = fileName.match(/\.md$/i)?.[0] ?? ".md";
  let stem = fileName.slice(0, fileName.length - extension.length) || "document";
  let suffix = attempt ? `-${attempt + 1}` : "";
  return `${directory}${stem}.${label}-${timestampForPath(now)}${suffix}${extension}`;
}

function timestampForPath(now: number) {
  return new Date(now).toISOString().replace(/\D/g, "").slice(0, 14);
}

export function hashMarkdownText(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function createDocumentId(backend: WorkspaceBackend, path: string) {
  let value = `${workspaceDocumentNamespace(backend)}:${path}`;
  try {
    let bytes = new TextEncoder().encode(value);
    let digest = await crypto.subtle.digest("SHA-256", bytes);
    return `doc-${encodeBase64Url(new Uint8Array(digest))}`;
  } catch {
    return `doc-${hashMarkdownText(value)}`;
  }
}

function workspaceDocumentNamespace(backend: WorkspaceBackend) {
  return `${backend.kind}:${backend.id}`;
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
