import { liveMdLoroCollaboration } from "@codemirror-treesitter/live-md-loro";
import type { Extension } from "@codemirror/state";
import { LoroDoc, UndoManager, VersionVector } from "loro-crdt";
import type { Frontiers } from "loro-crdt";
import type { WorkspaceBackend } from "@/lib/workspace-backend";
import { hashMarkdownText } from "../markdown-hash.ts";
import {
  appendBrowserCollabUpdates,
  clearBrowserCollabUpdates,
  loadBrowserCollabDocument,
  writeBrowserCollabSnapshot,
  type BrowserCollabDocumentMetadata,
  type SerializedCollabFrontier,
  type SerializedCollabVersionVector,
} from "./collab-browser-store.ts";

export { hashMarkdownText } from "../markdown-hash.ts";

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

export type CollabExternalEditResolution = {
  kind: "imported";
  path: string;
};

export type CollabSourceImportResult = {
  externalEdit: CollabExternalEditResolution;
  update: Uint8Array | null;
  value: string;
};

type OpenMarkdownCollabDocumentOptions = {
  reconcileExternalEdits?: boolean;
};

export type CollabDocumentMaterialization = {
  frontiers: SerializedCollabFrontier[];
  value: string;
  version: VersionVector;
  versionVector: SerializedCollabVersionVector;
};

export type MaterializeCollabDocumentResult = {
  externalEdit?: CollabExternalEditResolution;
};

type AcknowledgeCollabDocumentSourceSavedOptions = {
  externalEdit?: CollabExternalEditResolution;
  frontiers?: SerializedCollabFrontier[];
  versionVector?: SerializedCollabVersionVector;
};

type SourceCheckpoint = {
  frontiers: Frontiers;
  value: string;
  versionVector: VersionVector;
};

type SourceImportOutcome = {
  externalEdit?: CollabExternalEditResolution;
  metadata: BrowserCollabDocumentMetadata;
  update: Uint8Array | null;
  value: string;
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
      ...currentDocumentMaterializationFields(doc, initialValue),
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
): Promise<MaterializeCollabDocumentResult> {
  let sourceImport = await ingestExternalMarkdownEdit(backend, state);
  let materialization = captureCollabDocumentMaterialization(state);
  await saveCollabDocumentSnapshot(backend, state);
  await backend.writeFile(state.path, materialization.value);
  await acknowledgeCollabDocumentSourceSaved(backend, state, materialization.value, {
    externalEdit: sourceImport?.externalEdit,
    frontiers: materialization.frontiers,
    versionVector: materialization.versionVector,
  });
  return { externalEdit: sourceImport?.externalEdit };
}

export async function acknowledgeCollabDocumentSourceSaved(
  _backend: WorkspaceBackend,
  state: CollabDocumentState,
  value = getCollabDocumentValue(state),
  options: AcknowledgeCollabDocumentSourceSavedOptions = {},
) {
  state.metadata = {
    ...state.metadata,
    ...sourceCheckpointFields(
      value,
      options.frontiers ?? serializeFrontiers(state.doc.frontiers()),
      options.versionVector ?? serializeVersionVector(state.doc.oplogVersion()),
    ),
  };
  await writeBrowserCollabSnapshot(state.metadata, state.doc.export({ mode: "snapshot" }));
  state.cleanValue = value;
  state.externalEdit = options.externalEdit;
  state.value = value;
}

export function captureCollabDocumentMaterialization(
  state: CollabDocumentState,
): CollabDocumentMaterialization {
  state.doc.commit();
  let value = getCollabDocumentValue(state);
  let version = state.doc.oplogVersion();
  return {
    frontiers: serializeFrontiers(state.doc.frontiers()),
    value,
    version,
    versionVector: serializeVersionVector(version),
  };
}

export async function ingestExternalMarkdownEdit(
  backend: WorkspaceBackend,
  state: CollabDocumentState,
  sourceValue?: string,
): Promise<CollabSourceImportResult | null> {
  let outcome = await importExternalMarkdownEdit(backend, state.metadata, state.doc, sourceValue);
  state.metadata = outcome.metadata;
  state.value = outcome.value;

  if (!outcome.externalEdit) return null;
  state.externalEdit = outcome.externalEdit;
  if (outcome.update?.byteLength) state.pendingUpdates.push(new Uint8Array(outcome.update));
  return {
    externalEdit: outcome.externalEdit,
    update: outcome.update?.byteLength ? new Uint8Array(outcome.update) : null,
    value: outcome.value,
  };
}

export async function reloadCollabDocumentFromSource(
  backend: WorkspaceBackend,
  state: CollabDocumentState,
  sourceValue?: string,
): Promise<{ sourceValue: string }> {
  let value = sourceValue ?? (await backend.readFile(state.path));

  replaceMarkdownText(state.doc, value);
  await saveCollabDocumentSnapshot(backend, state);
  await acknowledgeCollabDocumentSourceSaved(backend, state, value);
  return { sourceValue: value };
}

async function reconcileExternalMarkdownEdit(
  backend: WorkspaceBackend,
  metadata: BrowserCollabDocumentMetadata,
  doc: LoroDoc,
): Promise<{
  externalEdit?: CollabExternalEditResolution;
  metadata: BrowserCollabDocumentMetadata;
}> {
  let outcome = await importExternalMarkdownEdit(backend, metadata, doc);
  if (outcome.metadata != metadata || outcome.externalEdit) {
    await compactDocumentSnapshot(outcome.metadata, doc);
  }
  return {
    externalEdit: outcome.externalEdit,
    metadata: outcome.metadata,
  };
}

async function importExternalMarkdownEdit(
  backend: WorkspaceBackend,
  metadata: BrowserCollabDocumentMetadata,
  doc: LoroDoc,
  sourceValue?: string,
): Promise<SourceImportOutcome> {
  let visibleValue = sourceValue ?? (await backend.readFile(metadata.path));
  let visibleHash = hashMarkdownText(visibleValue);
  let currentValue = doc.getText(textKey).toString();
  let currentHash = hashMarkdownText(currentValue);

  if (visibleValue == currentValue) {
    return {
      metadata: {
        ...metadata,
        ...currentDocumentMaterializationFields(doc, visibleValue),
      },
      update: null,
      value: currentValue,
    };
  }

  if (visibleHash == metadata.materializedHash) {
    return { metadata, update: null, value: currentValue };
  }

  let checkpoint = sourceCheckpointFromMetadata(metadata);
  if (checkpoint) {
    try {
      let fork = doc.forkAt(checkpoint.frontiers);
      let forkText = fork.getText(textKey);
      if (forkText.toString() == checkpoint.value) {
        forkText.update(visibleValue);
        let update = fork.export({ mode: "update", from: checkpoint.versionVector });
        let nextMetadata = {
          ...metadata,
          ...sourceCheckpointFields(
            visibleValue,
            serializeFrontiers(fork.frontiers()),
            serializeVersionVector(fork.oplogVersion()),
          ),
        };
        if (update.byteLength) doc.import(update);
        return {
          externalEdit: { kind: "imported", path: metadata.path },
          metadata: nextMetadata,
          update: update.byteLength ? new Uint8Array(update) : null,
          value: doc.getText(textKey).toString(),
        };
      }
    } catch {
      // Fall through to the legacy checkpoint path below.
    }
  }

  if (!metadata.materializedHash || currentHash == metadata.materializedHash) {
    let fromVersion = doc.oplogVersion();
    let text = doc.getText(textKey);
    text.update(visibleValue);
    let update = doc.export({ mode: "update", from: fromVersion });
    return {
      externalEdit: { kind: "imported", path: metadata.path },
      metadata: {
        ...metadata,
        ...currentDocumentMaterializationFields(doc, visibleValue),
      },
      update: update.byteLength ? new Uint8Array(update) : null,
      value: doc.getText(textKey).toString(),
    };
  }

  let fromVersion = doc.oplogVersion();
  doc.getText(textKey).update(visibleValue);
  let update = doc.export({ mode: "update", from: fromVersion });
  return {
    externalEdit: { kind: "imported", path: metadata.path },
    metadata: {
      ...metadata,
      ...currentDocumentMaterializationFields(doc, doc.getText(textKey).toString()),
    },
    update: update.byteLength ? new Uint8Array(update) : null,
    value: doc.getText(textKey).toString(),
  };
}

function sourceCheckpointFromMetadata(
  metadata: BrowserCollabDocumentMetadata,
): SourceCheckpoint | null {
  if (
    metadata.materializedValue == null ||
    !metadata.materializedFrontiers ||
    !metadata.materializedVersionVector
  ) {
    return null;
  }

  return {
    frontiers: deserializeFrontiers(metadata.materializedFrontiers),
    value: metadata.materializedValue,
    versionVector: deserializeVersionVector(metadata.materializedVersionVector),
  };
}

function currentDocumentMaterializationFields(doc: LoroDoc, value: string) {
  return sourceCheckpointFields(
    value,
    serializeFrontiers(doc.frontiers()),
    serializeVersionVector(doc.oplogVersion()),
  );
}

function sourceCheckpointFields(
  value: string,
  frontiers: SerializedCollabFrontier[],
  versionVector: SerializedCollabVersionVector,
) {
  return {
    materializedAt: Date.now(),
    materializedFrontiers: frontiers,
    materializedHash: hashMarkdownText(value),
    materializedValue: value,
    materializedVersionVector: versionVector,
  };
}

function serializeFrontiers(frontiers: Frontiers): SerializedCollabFrontier[] {
  return frontiers.map((frontier) => ({
    counter: frontier.counter,
    peer: String(frontier.peer) as `${number}`,
  }));
}

function deserializeFrontiers(frontiers: SerializedCollabFrontier[]): Frontiers {
  return frontiers.map((frontier) => ({
    counter: frontier.counter,
    peer: frontier.peer,
  }));
}

function serializeVersionVector(version: VersionVector): SerializedCollabVersionVector {
  return [...version.toJSON()].map(([peer, counter]) => [String(peer) as `${number}`, counter]);
}

function deserializeVersionVector(value: SerializedCollabVersionVector): VersionVector {
  return new VersionVector(new Map(value));
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
