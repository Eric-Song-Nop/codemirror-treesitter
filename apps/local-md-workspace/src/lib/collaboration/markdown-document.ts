import { liveMdLoroCollaboration } from "@codemirror-treesitter/live-md-loro";
import type { Extension } from "@codemirror/state";
import { LoroDoc, UndoManager } from "loro-crdt";
import type { WorkspaceBackend } from "@/lib/workspace-backend";
import {
  ensureManifestFile,
  loadWorkspaceManifest,
  updateManifestMaterialization,
  type WorkspaceManifestRecord,
} from "./workspace-manifest.ts";

const livemdDirectory = ".livemd";
const docsDirectory = `${livemdDirectory}/docs`;
const textKey = "markdown";
const maxDocumentUpdateLogBytes = 64 * 1024;
const updateSegmentFilePattern = /^(\d{6})\.update\.b64$/;

export type CollabDocumentState = {
  cleanValue: string;
  doc: LoroDoc;
  docId: string;
  dispose: () => void;
  externalEdit?: CollabExternalEditResolution;
  extensions: Extension[];
  manifestCreated: boolean;
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
  ensureCollabBackend(backend);

  let { created, record } = await ensureManifestFile(backend, path);

  let doc = new LoroDoc();
  let snapshot = await readDocumentSnapshot(backend, record.docId);
  let updateLog = await readDocumentUpdateLog(backend, record.docId);
  let updates = updateLog.updates;
  let externalEdit: CollabExternalEditResolution | undefined;

  if (snapshot) {
    doc.import(snapshot);
    if (updates.length) doc.importBatch(updates);
    if (options.reconcileExternalEdits ?? true) {
      externalEdit = await reconcileExternalMarkdownEdit(backend, record, doc);
    }
    if (updateLog.hasLegacyLog) {
      await compactDocumentSnapshot(backend, record.docId, doc);
    }
  } else {
    if (updates.length) doc.importBatch(updates);
    if (!created && !updates.length && record.materializedHash) {
      throw new Error(
        `Collaboration state for ${path} is not available yet. If this is a Dropbox mirror, wait for sync to finish and retry.`,
      );
    }

    let initialValue = await backend.readFile(path);
    let text = doc.getText(textKey);
    if (!text.toString() && initialValue) text.insert(0, initialValue);
    if (initialValue || updates.length) doc.commit();
    await compactDocumentSnapshot(backend, record.docId, doc);
    await updateManifestMaterialization(backend, record.docId, {
      materializedAt: Date.now(),
      materializedHash: hashMarkdownText(initialValue),
    });
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
    docId: record.docId,
    dispose: unsubscribeLocalUpdates,
    externalEdit,
    extensions: [liveMdLoroCollaboration({ doc, undoManager, text: textKey })],
    manifestCreated: created,
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
  backend: WorkspaceBackend,
  state: CollabDocumentState,
) {
  ensureCollabBackend(backend);
  await enqueueDocumentPersistence(state, async () => {
    let updates = state.pendingUpdates.splice(0);
    try {
      await writeDocumentSnapshot(backend, state.docId, state.doc);
    } catch (error) {
      state.pendingUpdates.unshift(...updates);
      throw error;
    }
    await deleteDocumentUpdateLog(backend, state.docId);
  });
}

export async function savePendingCollabDocumentUpdates(
  backend: WorkspaceBackend,
  state: CollabDocumentState,
) {
  ensureCollabBackend(backend);
  if (!state.pendingUpdates.length) return;

  await enqueueDocumentPersistence(state, async () => {
    if (!state.pendingUpdates.length) return;

    let updates = state.pendingUpdates.splice(0);
    let updateLogBytes: number;
    try {
      updateLogBytes = await appendDocumentUpdates(backend, state.docId, updates);
    } catch (error) {
      state.pendingUpdates.unshift(...updates);
      throw error;
    }

    if (updateLogBytes >= maxDocumentUpdateLogBytes) {
      await compactDocumentSnapshot(backend, state.docId, state.doc);
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
  await updateManifestMaterialization(backend, state.docId, {
    materializedAt: Date.now(),
    materializedHash: hashMarkdownText(value),
  });
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
  await updateManifestMaterialization(backend, state.docId, {
    materializedAt: Date.now(),
    materializedHash: hashMarkdownText(sourceValue),
  });
  state.cleanValue = sourceValue;
  state.externalEdit = externalEdit;
  state.value = sourceValue;
  return { externalEdit, sourceValue };
}

function ensureCollabBackend(
  backend: WorkspaceBackend,
): asserts backend is WorkspaceBackend &
  Required<
    Pick<
      WorkspaceBackend,
      | "createDirectory"
      | "deleteEntry"
      | "listEntries"
      | "readBytes"
      | "readTextFile"
      | "writeBytes"
      | "writeTextFile"
    >
  > {
  if (
    !backend.createDirectory ||
    !backend.deleteEntry ||
    !backend.listEntries ||
    !backend.readBytes ||
    !backend.readTextFile ||
    !backend.writeBytes ||
    !backend.writeTextFile
  ) {
    throw new Error("This workspace backend does not support local-first collaboration storage.");
  }
}

async function reconcileExternalMarkdownEdit(
  backend: WorkspaceBackend,
  record: WorkspaceManifestRecord,
  doc: LoroDoc,
): Promise<CollabExternalEditResolution | undefined> {
  if (!record.materializedHash) {
    let visibleValue = await backend.readFile(record.path);
    if (hashMarkdownText(visibleValue) == hashMarkdownText(doc.getText(textKey).toString())) {
      await updateManifestMaterialization(backend, record.docId, {
        materializedAt: Date.now(),
        materializedHash: hashMarkdownText(visibleValue),
      });
    }
    return undefined;
  }

  let visibleValue = await backend.readFile(record.path);
  let visibleHash = hashMarkdownText(visibleValue);
  if (visibleHash == record.materializedHash) return undefined;

  let docValue = doc.getText(textKey).toString();
  if (hashMarkdownText(docValue) == record.materializedHash) {
    replaceMarkdownText(doc, visibleValue);
    await compactDocumentSnapshot(backend, record.docId, doc);
    await updateManifestMaterialization(backend, record.docId, {
      materializedAt: Date.now(),
      materializedHash: visibleHash,
    });
    return { kind: "imported", path: record.path };
  }

  return {
    kind: "conflict-copy",
    path: await writeExternalConflictCopy(backend, record.path, visibleValue),
    sourcePath: record.path,
  };
}

async function loadManifestRecordByDocId(backend: WorkspaceBackend, docId: string) {
  let manifest = await loadWorkspaceManifest(backend);
  return manifest.records.find((record) => record.docId == docId && record.deletedAt == null);
}

async function findMaterializationConflict(
  backend: WorkspaceBackend,
  state: CollabDocumentState,
  value = getCollabDocumentValue(state),
): Promise<MaterializationConflictDetails | null> {
  let record = await loadManifestRecordByDocId(backend, state.docId);
  if (!record?.materializedHash) return null;

  let visibleValue = await backend.readFile(state.path);
  let externalHash = hashMarkdownText(visibleValue);
  if (externalHash == record.materializedHash || visibleValue == value) return null;

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

async function readDocumentSnapshot(backend: WorkspaceBackend, docId: string) {
  let path = documentSnapshotPath(docId);
  try {
    return (await backend.readBytes?.(path)) ?? null;
  } catch (error) {
    if (isMissingEntryError(error)) return null;
    throw error;
  }
}

async function readDocumentUpdateLog(backend: WorkspaceBackend, docId: string) {
  let updates = await readDocumentUpdateSegments(backend, docId);
  let legacyUpdates = await readLegacyDocumentUpdateLog(backend, docId);
  return {
    hasLegacyLog: legacyUpdates != null,
    updates: [...(legacyUpdates ?? []), ...updates],
  };
}

async function readLegacyDocumentUpdateLog(backend: WorkspaceBackend, docId: string) {
  let path = legacyDocumentUpdateLogPath(docId);
  try {
    let bytes = (await backend.readBytes?.(path)) ?? null;
    return bytes ? decodeUpdateLog(bytes) : [];
  } catch (error) {
    if (isMissingEntryError(error)) return null;
    throw error;
  }
}

async function readDocumentUpdateSegments(backend: WorkspaceBackend, docId: string) {
  let updates: Uint8Array[] = [];
  for (let segment of await listDocumentUpdateSegments(backend, docId)) {
    let bytes = await backend.readBytes?.(segment.path);
    if (bytes) updates.push(...decodeUpdateLog(bytes));
  }
  return updates;
}

async function writeDocumentSnapshot(backend: WorkspaceBackend, docId: string, doc: LoroDoc) {
  await backend.createDirectory?.(docsDirectory);
  await backend.writeBytes?.(documentSnapshotPath(docId), doc.export({ mode: "snapshot" }));
}

async function compactDocumentSnapshot(backend: WorkspaceBackend, docId: string, doc: LoroDoc) {
  await writeDocumentSnapshot(backend, docId, doc);
  await deleteDocumentUpdateLog(backend, docId);
}

async function appendDocumentUpdates(
  backend: WorkspaceBackend,
  docId: string,
  updates: Uint8Array[],
) {
  let encoded = encodeUpdateLog(updates);
  await backend.createDirectory?.(docsDirectory);
  await backend.createDirectory?.(documentUpdateLogDirectoryPath(docId));
  let nextSequence = (await lastDocumentUpdateSegmentSequence(backend, docId)) + 1;
  await backend.writeBytes?.(documentUpdateSegmentPath(docId, nextSequence), encoded);
  return documentUpdateLogByteLength(backend, docId);
}

async function deleteDocumentUpdateLog(backend: WorkspaceBackend, docId: string) {
  await deleteIfPresent(backend, legacyDocumentUpdateLogPath(docId));
  await deleteIfPresent(backend, documentUpdateLogDirectoryPath(docId), { recursive: true });
}

function documentSnapshotPath(docId: string) {
  return `${docsDirectory}/${docId}.snapshot.b64`;
}

function legacyDocumentUpdateLogPath(docId: string) {
  return `${docsDirectory}/${docId}.updates.b64`;
}

function documentUpdateLogDirectoryPath(docId: string) {
  return `${docsDirectory}/${docId}.updates`;
}

function documentUpdateSegmentPath(docId: string, sequence: number) {
  return `${documentUpdateLogDirectoryPath(docId)}/${formatUpdateSegmentSequence(sequence)}.update.b64`;
}

function formatUpdateSegmentSequence(sequence: number) {
  return String(sequence).padStart(6, "0");
}

async function listDocumentUpdateSegments(backend: WorkspaceBackend, docId: string) {
  let directory = documentUpdateLogDirectoryPath(docId);
  try {
    let entries = await backend.listEntries?.(directory);
    return (entries ?? [])
      .filter(
        (entry) =>
          entry.isFile && updateSegmentFilePattern.test(entry.path.split("/").at(-1) ?? ""),
      )
      .sort((a, b) => segmentSequence(a.path) - segmentSequence(b.path));
  } catch (error) {
    if (isMissingEntryError(error)) return [];
    throw error;
  }
}

async function lastDocumentUpdateSegmentSequence(backend: WorkspaceBackend, docId: string) {
  let segments = await listDocumentUpdateSegments(backend, docId);
  return segments.reduce((max, segment) => Math.max(max, segmentSequence(segment.path)), 0);
}

async function documentUpdateLogByteLength(backend: WorkspaceBackend, docId: string) {
  let total = await byteLengthIfPresent(backend, legacyDocumentUpdateLogPath(docId));
  for (let segment of await listDocumentUpdateSegments(backend, docId)) {
    total += await byteLengthIfPresent(backend, segment.path);
  }
  return total;
}

async function byteLengthIfPresent(backend: WorkspaceBackend, path: string) {
  try {
    let stat = await backend.stat?.(path);
    if (stat?.exists && typeof stat.size == "number") return stat.size;
    return (await backend.readBytes?.(path))?.byteLength ?? 0;
  } catch (error) {
    if (isMissingEntryError(error)) return 0;
    throw error;
  }
}

async function deleteIfPresent(
  backend: WorkspaceBackend,
  path: string,
  options: { recursive?: boolean } = {},
) {
  try {
    await backend.deleteEntry?.(path, options);
  } catch (error) {
    if (!isMissingEntryError(error)) throw error;
  }
}

function segmentSequence(path: string) {
  let fileName = path.split("/").at(-1) ?? "";
  let match = updateSegmentFilePattern.exec(fileName);
  return match ? Number(match[1]) : 0;
}

function encodeUpdateLog(updates: Uint8Array[]) {
  let byteLength = updates.reduce((total, update) => total + 4 + update.byteLength, 0);
  let bytes = new Uint8Array(byteLength);
  let view = new DataView(bytes.buffer);
  let offset = 0;

  for (let update of updates) {
    view.setUint32(offset, update.byteLength);
    offset += 4;
    bytes.set(update, offset);
    offset += update.byteLength;
  }

  return bytes;
}

function decodeUpdateLog(bytes: Uint8Array) {
  let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let updates: Uint8Array[] = [];
  let offset = 0;

  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength)
      throw new Error("Truncated collaboration update log header.");
    let length = view.getUint32(offset);
    offset += 4;
    if (offset + length > bytes.byteLength) {
      throw new Error("Truncated collaboration update log payload.");
    }
    updates.push(bytes.slice(offset, offset + length));
    offset += length;
  }

  return updates;
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
  ensureCollabBackend(backend);

  for (let attempt = 0; attempt < 1000; attempt++) {
    let conflictPath = conflictCopyPath(path, label, Date.now(), attempt);
    if (backend.stat) {
      let stat = await backend.stat(conflictPath);
      if (stat.exists) continue;
    }

    await backend.writeTextFile(conflictPath, value);
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

function isMissingEntryError(error: unknown) {
  if (error instanceof DOMException) return error.name == "NotFoundError";
  let message = error instanceof Error ? error.message : String(error);
  return /not.?found|not_found|404/i.test(message);
}

export function hashMarkdownText(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
