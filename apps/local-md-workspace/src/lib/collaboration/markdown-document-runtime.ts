import { liveMdLoroCollaborationPlugin } from "@codemirror-treesitter/live-md-loro";
import type { LiveMdConfig } from "@codemirror-treesitter/live-md";
import { LoroDoc, UndoManager, VersionVector } from "loro-crdt";
import type { Frontiers } from "loro-crdt";
import { createDebouncedTask, type DebouncedTask } from "@/lib/scheduling/debounced-task";
import type { SourceObservation } from "@/lib/workspace/storage/types";
import type {
  DocumentSourceState,
  WorkspaceDocumentPort,
  WorkspaceIdentity,
  WorkspaceTextSnapshot,
} from "@/lib/workspace/runtime/types";
import {
  documentSourceAliasRefs,
  documentSourceDocumentIdInput,
  documentSourceRef,
  type DocumentSourceRef,
} from "@/lib/workspace/source-identity";
import { hashMarkdownText } from "./markdown-hash.ts";
import {
  appendBrowserCollabUpdates,
  clearBrowserCollabUpdates,
  loadBrowserCollabDocument,
  writeBrowserCollabSnapshot,
  type BrowserCollabDocumentState,
  type BrowserCollabDocumentMetadata,
  type SerializedCollabFrontier,
  type SerializedCollabVersionVector,
} from "./collab-browser-store.ts";

export { hashMarkdownText } from "./markdown-hash.ts";

const textKey = "markdown";
const maxDocumentUpdateLogBytes = 64 * 1024;
const pendingUpdateFlushDelayMs = 300;
const pendingUpdateFlushMaxWaitMs = 2000;
const snapshotFlushDelayMs = 300;
const snapshotFlushMaxWaitMs = 2000;

export type CollabDocumentState = {
  cleanValue: string;
  doc: LoroDoc;
  docId: string;
  dispose: () => Promise<void>;
  externalEdit?: CollabExternalEditResolution;
  liveMdConfig: LiveMdConfig;
  metadata: BrowserCollabDocumentMetadata;
  path: string;
  pendingUpdateFlush: DebouncedTask;
  pendingUpdates: Uint8Array[];
  persistence: Promise<void>;
  snapshotFlush: DebouncedTask;
  source: DocumentSourceState;
  sourceState: CollabSourceState;
  undoManager: UndoManager;
  value: string;
};

export type CollabExternalEditResolution = {
  kind: "imported";
  path: string;
};

export type CollabSourceState =
  | {
      kind: "blocked";
    }
  | {
      kind: "needs-write";
    }
  | {
      kind: "synced";
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
  versionVector: SerializedCollabVersionVector;
};

export type MaterializeCollabDocumentResult = {
  externalEdit?: CollabExternalEditResolution;
  materialization: CollabDocumentMaterialization;
  sourceUpdate: Uint8Array | null;
};

type AcknowledgeCollabDocumentSourceSavedOptions = {
  externalEdit?: CollabExternalEditResolution;
  frontiers?: SerializedCollabFrontier[];
  source?: {
    contentHash: string;
    revision: import("@/lib/workspace/storage/types").SourceRevision;
  };
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
  sourceState: CollabSourceState;
  source: DocumentSourceState;
  update: Uint8Array | null;
  value: string;
};

type StoredCollabDocumentCandidate = BrowserCollabDocumentState & {
  metadata: BrowserCollabDocumentMetadata;
  migratedFromAlias: boolean;
  snapshot: Uint8Array;
};

export type CollabDocumentSource =
  | { documentSource: WorkspaceDocumentPort; identity: WorkspaceIdentity }
  | { documents: WorkspaceDocumentPort; identity: WorkspaceIdentity };

export async function openMarkdownCollabDocument(
  backend: CollabDocumentSource,
  path: string,
  options: OpenMarkdownCollabDocumentOptions = {},
): Promise<CollabDocumentState> {
  let identity = backend.identity;
  let sourceRef = documentSourceRef(identity, path);
  let docId = await createDocumentIdForSourceRef(sourceRef);
  let workspaceId = sourceRef.workspaceNamespace;
  let stored = await loadStoredCollabDocumentCandidate(identity, path, sourceRef, docId);
  let doc = new LoroDoc();
  let undoManager: UndoManager | null = null;
  let externalEdit: CollabExternalEditResolution | undefined;
  let sourceState: CollabSourceState = { kind: "synced" };
  let source: DocumentSourceState;
  let metadata: BrowserCollabDocumentMetadata;

  try {
    if (stored) {
      metadata = stored.metadata;
      doc.import(stored.snapshot);
      if (stored.updates.length) doc.importBatch(stored.updates);
      if (options.reconcileExternalEdits ?? true) {
        let observation = await observeCollabSource(backend, path);
        let result = await reconcileExternalMarkdownObservation(observation, metadata, doc);
        externalEdit = result.externalEdit;
        metadata = result.metadata;
        source = result.source;
        sourceState = result.sourceState;
      } else {
        source = sourceStateFromMetadata(metadata);
      }
      if (stored.migratedFromAlias) await compactDocumentSnapshot(metadata, doc);
    } else {
      let observation = await observeCollabSource(backend, path);
      if (observation.state == "missing") throw new Error(`${path} does not exist.`);
      if (observation.state == "unavailable") throw observation.error;
      let initialValue = observation.value.value;
      let text = doc.getText(textKey);
      try {
        if (initialValue) text.insert(0, initialValue);
        if (initialValue) doc.commit();
      } finally {
        text.free();
      }
      metadata = {
        docId,
        path,
        ...sourceMetadataFields(observation.value),
        workspaceId,
        ...currentDocumentMaterializationFields(doc, initialValue),
      };
      await compactDocumentSnapshot(metadata, doc);
      source = presentSourceState(observation.value);
    }

    let ownedUndoManager = new UndoManager(doc, {});
    undoManager = ownedUndoManager;
    let value = readMarkdownText(doc);
    if (!(options.reconcileExternalEdits ?? true)) {
      sourceState = sourceStateForValue(metadata, value);
    }
    let pendingUpdates: Uint8Array[] = [];
    let state: CollabDocumentState;
    let pendingUpdateFlush = createDebouncedTask({
      delayMs: pendingUpdateFlushDelayMs,
      maxWaitMs: pendingUpdateFlushMaxWaitMs,
      run: () => appendPendingCollabDocumentUpdates(state),
    });
    let snapshotFlush = createDebouncedTask({
      delayMs: snapshotFlushDelayMs,
      maxWaitMs: snapshotFlushMaxWaitMs,
      run: () => writeCollabDocumentSnapshot(state),
    });
    let disposePromise: Promise<void> | null = null;
    let unsubscribeLocalUpdates = doc.subscribeLocalUpdates((bytes) => {
      pendingUpdates.push(new Uint8Array(bytes));
      schedulePendingCollabDocumentUpdateFlush(state);
    });

    state = {
      cleanValue: value,
      doc,
      docId,
      dispose() {
        if (disposePromise) return disposePromise;
        unsubscribeLocalUpdates();
        disposePromise = (async () => {
          try {
            await flushCollabDocumentPersistence(state);
          } finally {
            pendingUpdateFlush.dispose();
            snapshotFlush.dispose();
            ownedUndoManager.free();
            doc.free();
          }
        })();
        return disposePromise;
      },
      externalEdit,
      liveMdConfig: {
        plugins: [
          liveMdLoroCollaborationPlugin({ doc, undoManager: ownedUndoManager, text: textKey }),
        ],
      },
      metadata,
      path,
      pendingUpdateFlush,
      pendingUpdates,
      persistence: Promise.resolve(),
      snapshotFlush,
      source,
      sourceState,
      undoManager: ownedUndoManager,
      value,
    };
    return state;
  } catch (error) {
    undoManager?.free();
    doc.free();
    throw error;
  }
}

async function loadStoredCollabDocumentCandidate(
  backend: WorkspaceIdentity,
  path: string,
  sourceRef: DocumentSourceRef,
  docId: string,
): Promise<StoredCollabDocumentCandidate | null> {
  let stored = await loadBrowserCollabDocument(docId);
  let metadata = storedCollabMetadataForSource(stored, path, sourceRef.workspaceNamespace);
  if (stored.snapshot && metadata) {
    return {
      ...stored,
      metadata,
      migratedFromAlias: false,
      snapshot: stored.snapshot,
    };
  }

  for (let aliasRef of documentSourceAliasRefs(backend, path)) {
    let aliasDocId = await createDocumentIdForSourceRef(aliasRef);
    if (aliasDocId == docId) continue;

    let aliasStored = await loadBrowserCollabDocument(aliasDocId);
    let aliasMetadata = storedCollabMetadataForSource(
      aliasStored,
      path,
      aliasRef.workspaceNamespace,
    );
    if (!aliasStored.snapshot || !aliasMetadata) continue;

    return {
      ...aliasStored,
      metadata: {
        ...aliasMetadata,
        docId,
        path,
        workspaceId: sourceRef.workspaceNamespace,
      },
      migratedFromAlias: true,
      snapshot: aliasStored.snapshot,
    };
  }

  return null;
}

function storedCollabMetadataForSource(
  stored: BrowserCollabDocumentState,
  path: string,
  workspaceId: string,
) {
  return stored.metadata &&
    stored.metadata.path == path &&
    stored.metadata.workspaceId == workspaceId
    ? stored.metadata
    : null;
}

export function getCollabDocumentValue(state: CollabDocumentState) {
  return readMarkdownText(state.doc);
}

export function collabDocumentNeedsSourceWrite(state: CollabDocumentState) {
  return state.sourceState.kind == "needs-write";
}

export async function saveCollabDocumentSnapshot(
  _backend: CollabDocumentSource,
  state: CollabDocumentState,
) {
  state.snapshotFlush.cancel();
  await writeCollabDocumentSnapshot(state);
}

export function scheduleCollabDocumentSnapshotFlush(state: CollabDocumentState) {
  state.snapshotFlush.schedule();
}

export async function flushCollabDocumentSnapshot(state: CollabDocumentState) {
  state.snapshotFlush.schedule();
  await state.snapshotFlush.flush();
}

async function writeCollabDocumentSnapshot(state: CollabDocumentState) {
  state.pendingUpdateFlush.cancel();
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
  _backend: CollabDocumentSource,
  state: CollabDocumentState,
) {
  if (!state.pendingUpdates.length) return;
  state.pendingUpdateFlush.schedule();
  await state.pendingUpdateFlush.flush();
}

export function schedulePendingCollabDocumentUpdateFlush(state: CollabDocumentState) {
  if (!state.pendingUpdates.length) return;
  state.pendingUpdateFlush.schedule();
}

export async function flushPendingCollabDocumentUpdates(state: CollabDocumentState) {
  if (!state.pendingUpdates.length) return;
  state.pendingUpdateFlush.schedule();
  await state.pendingUpdateFlush.flush();
}

export async function flushCollabDocumentPersistence(state: CollabDocumentState) {
  if (state.snapshotFlush.pending()) {
    await state.snapshotFlush.flush();
  } else {
    await flushPendingCollabDocumentUpdates(state);
  }
  await state.persistence;
}

async function appendPendingCollabDocumentUpdates(state: CollabDocumentState) {
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
  backend: CollabDocumentSource,
  state: CollabDocumentState,
): Promise<MaterializeCollabDocumentResult> {
  let sourceImport = await ingestExternalMarkdownEdit(backend, state);
  let materialization = captureCollabDocumentMaterialization(state);
  await saveCollabDocumentSnapshot(backend, state);
  if (state.source.kind != "present") {
    throw new Error(`The source for ${state.path} must be reconciled before materialization.`);
  }
  let result = await collabSourceDocuments(backend).commit({
    condition: { kind: "if-unchanged", revision: state.source.baseline.revision },
    path: state.path,
    value: materialization.value,
  });
  if (result.status != "committed") {
    throw new Error(`Workspace materialization for ${state.path} ended with ${result.status}.`);
  }
  let committed = await collabSourceDocuments(backend).observe(state.path);
  if (committed.state != "present" || committed.value.value != materialization.value) {
    throw new Error(`Workspace materialization for ${state.path} could not be verified.`);
  }
  await acknowledgeCollabDocumentSourceSaved(backend, state, materialization.value, {
    externalEdit: sourceImport?.externalEdit,
    frontiers: materialization.frontiers,
    source: {
      contentHash: committed.value.contentHash,
      revision: committed.value.revision,
    },
    versionVector: materialization.versionVector,
  });
  return {
    externalEdit: sourceImport?.externalEdit,
    materialization,
    sourceUpdate: sourceImport?.update ?? null,
  };
}

export async function acknowledgeCollabDocumentSourceSaved(
  _backend: CollabDocumentSource,
  state: CollabDocumentState,
  value = getCollabDocumentValue(state),
  options: AcknowledgeCollabDocumentSourceSavedOptions = {},
) {
  state.metadata = {
    ...state.metadata,
    ...(options.source
      ? {
          sourceContentHash: options.source.contentHash,
          sourceRevision: options.source.revision,
        }
      : null),
    ...sourceCheckpointFields(
      value,
      options.frontiers ?? serializeFrontiers(state.doc.frontiers()),
      options.versionVector ?? serializeCurrentVersion(state.doc),
    ),
  };
  await writeBrowserCollabSnapshot(state.metadata, state.doc.export({ mode: "snapshot" }));
  state.cleanValue = value;
  state.externalEdit = options.externalEdit;
  state.sourceState = { kind: "synced" };
  if (options.source) {
    state.source = { baseline: options.source, kind: "present" };
  }
  state.value = value;
}

export function captureCollabDocumentMaterialization(
  state: CollabDocumentState,
): CollabDocumentMaterialization {
  state.doc.commit();
  let value = getCollabDocumentValue(state);
  return {
    frontiers: serializeFrontiers(state.doc.frontiers()),
    value,
    versionVector: serializeCurrentVersion(state.doc),
  };
}

export async function ingestExternalMarkdownEdit(
  source: CollabDocumentSource,
  state: CollabDocumentState,
): Promise<CollabSourceImportResult | null> {
  let observation = await observeCollabSource(source, state.path);
  return ingestExternalMarkdownObservation(state, observation);
}

export async function ingestExternalMarkdownObservation(
  state: CollabDocumentState,
  observation: SourceObservation<WorkspaceTextSnapshot>,
): Promise<CollabSourceImportResult | null> {
  let outcome = await importExternalMarkdownObservation(observation, state.metadata, state.doc);
  state.metadata = outcome.metadata;
  state.source = outcome.source;
  state.sourceState = outcome.sourceState;
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

async function reconcileExternalMarkdownObservation(
  observation: SourceObservation<WorkspaceTextSnapshot>,
  metadata: BrowserCollabDocumentMetadata,
  doc: LoroDoc,
): Promise<{
  externalEdit?: CollabExternalEditResolution;
  metadata: BrowserCollabDocumentMetadata;
  source: DocumentSourceState;
  sourceState: CollabSourceState;
}> {
  let outcome = await importExternalMarkdownObservation(observation, metadata, doc);
  if (outcome.metadata != metadata || outcome.externalEdit) {
    await compactDocumentSnapshot(outcome.metadata, doc);
  }
  return {
    externalEdit: outcome.externalEdit,
    metadata: outcome.metadata,
    source: outcome.source,
    sourceState: outcome.sourceState,
  };
}

async function importExternalMarkdownObservation(
  observation: SourceObservation<WorkspaceTextSnapshot>,
  metadata: BrowserCollabDocumentMetadata,
  doc: LoroDoc,
): Promise<SourceImportOutcome> {
  if (observation.state == "missing") {
    return {
      metadata,
      source: { kind: "missing", lastPresent: baselineFromMetadata(metadata) },
      sourceState: { kind: "blocked" },
      update: null,
      value: readMarkdownText(doc),
    };
  }
  if (observation.state == "unavailable") {
    return {
      metadata,
      source: {
        error: observation.error,
        kind: "unavailable",
        lastPresent: baselineFromMetadata(metadata),
      },
      sourceState: { kind: "blocked" },
      update: null,
      value: readMarkdownText(doc),
    };
  }

  let snapshot = observation.value;
  let visibleValue = snapshot.value;
  let visibleHash = hashMarkdownText(visibleValue);
  let currentValue = readMarkdownText(doc);
  let currentHash = hashMarkdownText(currentValue);

  if (visibleValue == currentValue) {
    return {
      metadata: {
        ...metadata,
        ...currentDocumentMaterializationFields(doc, visibleValue),
        ...sourceMetadataFields(snapshot),
      },
      source: presentSourceState(snapshot),
      sourceState: { kind: "synced" },
      update: null,
      value: currentValue,
    };
  }

  if (visibleHash == metadata.materializedHash) {
    return {
      metadata: { ...metadata, ...sourceMetadataFields(snapshot) },
      source: presentSourceState(snapshot),
      sourceState: sourceStateForSourceValue(currentValue, visibleValue),
      update: null,
      value: currentValue,
    };
  }

  try {
    let checkpoint = sourceCheckpointFromMetadata(metadata);
    let fork: LoroDoc | null = null;
    try {
      fork = doc.forkAt(checkpoint.frontiers);
      let forkText = fork.getText(textKey);
      try {
        if (forkText.toString() == checkpoint.value) {
          forkText.update(visibleValue);
          let update = fork.export({ mode: "update", from: checkpoint.versionVector });
          let nextMetadata = {
            ...metadata,
            ...sourceCheckpointFields(
              visibleValue,
              serializeFrontiers(fork.frontiers()),
              serializeCurrentVersion(fork),
            ),
            ...sourceMetadataFields(snapshot),
          };
          if (update.byteLength) doc.import(update);
          let value = readMarkdownText(doc);
          return {
            externalEdit: { kind: "imported", path: metadata.path },
            metadata: nextMetadata,
            source: presentSourceState(snapshot),
            sourceState: sourceStateForSourceValue(value, visibleValue),
            update: update.byteLength ? new Uint8Array(update) : null,
            value,
          };
        }
      } finally {
        forkText.free();
      }
    } finally {
      fork?.free();
      checkpoint.versionVector.free();
    }
  } catch {
    // A complete but unusable checkpoint is treated as a bad browser snapshot.
  }

  if (currentHash == metadata.materializedHash) {
    let fromVersion = doc.oplogVersion();
    try {
      let text = doc.getText(textKey);
      try {
        text.update(visibleValue);
      } finally {
        text.free();
      }
      let update = doc.export({ mode: "update", from: fromVersion });
      return {
        externalEdit: { kind: "imported", path: metadata.path },
        metadata: {
          ...metadata,
          ...currentDocumentMaterializationFields(doc, visibleValue),
          ...sourceMetadataFields(snapshot),
        },
        source: presentSourceState(snapshot),
        sourceState: { kind: "synced" },
        update: update.byteLength ? new Uint8Array(update) : null,
        value: readMarkdownText(doc),
      };
    } finally {
      fromVersion.free();
    }
  }

  return {
    metadata,
    source: {
      incoming: snapshot,
      kind: "recovery-required",
      lastPresent: baselineFromMetadata(metadata) ?? {
        contentHash: `legacy:${metadata.materializedHash}`,
        revision: {
          kind: "fingerprint",
          validation: "observed",
          value: `legacy-checkpoint:${metadata.materializedHash}`,
        },
      },
    },
    sourceState: { kind: "blocked" },
    update: null,
    value: currentValue,
  };
}

export async function resolveCollabRecoveryUseExternal(
  state: CollabDocumentState,
  snapshot: WorkspaceTextSnapshot,
  confirmedIncomingRevision: import("@/lib/workspace/storage/types").SourceRevision,
) {
  if (state.source.kind != "recovery-required") {
    throw new Error("The document is not awaiting external-source recovery.");
  }
  if (!sameSourceRevision(snapshot.revision, confirmedIncomingRevision)) {
    return { status: "incoming-changed" as const };
  }

  let fromVersion = state.doc.oplogVersion();
  try {
    replaceMarkdownText(state.doc, snapshot.value);
    let update = state.doc.export({ mode: "update", from: fromVersion });
    state.metadata = {
      ...state.metadata,
      ...currentDocumentMaterializationFields(state.doc, snapshot.value),
      ...sourceMetadataFields(snapshot),
    };
    state.source = presentSourceState(snapshot);
    state.sourceState = { kind: "synced" };
    state.cleanValue = snapshot.value;
    state.value = snapshot.value;
    state.externalEdit = { kind: "imported", path: state.path };
    if (update.byteLength) state.pendingUpdates.push(new Uint8Array(update));
    await compactDocumentSnapshot(state.metadata, state.doc);
    return { status: "applied" as const, update: new Uint8Array(update) };
  } finally {
    fromVersion.free();
  }
}

function observeCollabSource(
  source: CollabDocumentSource,
  path: string,
): Promise<SourceObservation<WorkspaceTextSnapshot>> {
  return collabSourceDocuments(source).observe(path);
}

function collabSourceDocuments(source: CollabDocumentSource) {
  return "documentSource" in source ? source.documentSource : source.documents;
}

function sourceMetadataFields(snapshot: WorkspaceTextSnapshot) {
  return {
    sourceContentHash: snapshot.contentHash,
    sourceRevision: snapshot.revision,
  };
}

function presentSourceState(snapshot: WorkspaceTextSnapshot): DocumentSourceState {
  return {
    baseline: { contentHash: snapshot.contentHash, revision: snapshot.revision },
    kind: "present",
  };
}

function sourceStateFromMetadata(metadata: BrowserCollabDocumentMetadata): DocumentSourceState {
  let baseline = baselineFromMetadata(metadata);
  return baseline ? { baseline, kind: "present" } : { kind: "missing" };
}

function baselineFromMetadata(metadata: BrowserCollabDocumentMetadata) {
  return metadata.sourceContentHash && metadata.sourceRevision
    ? { contentHash: metadata.sourceContentHash, revision: metadata.sourceRevision }
    : undefined;
}

function sameSourceRevision(
  left: import("@/lib/workspace/storage/types").SourceRevision,
  right: import("@/lib/workspace/storage/types").SourceRevision,
) {
  return (
    left.kind == right.kind && left.validation == right.validation && left.value == right.value
  );
}

function sourceCheckpointFromMetadata(metadata: BrowserCollabDocumentMetadata): SourceCheckpoint {
  return {
    frontiers: deserializeFrontiers(metadata.materializedFrontiers),
    value: metadata.materializedValue,
    versionVector: deserializeVersionVector(metadata.materializedVersionVector),
  };
}

function sourceStateForValue(metadata: BrowserCollabDocumentMetadata, value: string) {
  return metadata.materializedValue != value
    ? ({ kind: "needs-write" } as const)
    : ({ kind: "synced" } as const);
}

function sourceStateForSourceValue(value: string, sourceValue: string): CollabSourceState {
  return value == sourceValue ? { kind: "synced" } : { kind: "needs-write" };
}

function currentDocumentMaterializationFields(doc: LoroDoc, value: string) {
  return sourceCheckpointFields(
    value,
    serializeFrontiers(doc.frontiers()),
    serializeCurrentVersion(doc),
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

function serializeCurrentVersion(doc: LoroDoc): SerializedCollabVersionVector {
  let version = doc.oplogVersion();
  try {
    return serializeVersionVector(version);
  } finally {
    version.free();
  }
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
  try {
    let current = text.toString();
    if (current == value) return;

    if (current) text.delete(0, current.length);
    if (value) text.insert(0, value);
    doc.commit();
  } finally {
    text.free();
  }
}

function readMarkdownText(doc: LoroDoc) {
  let text = doc.getText(textKey);
  try {
    return text.toString();
  } finally {
    text.free();
  }
}

async function createDocumentIdForSourceRef(sourceRef: DocumentSourceRef) {
  let value = documentSourceDocumentIdInput(sourceRef);
  try {
    let bytes = new TextEncoder().encode(value);
    let digest = await crypto.subtle.digest("SHA-256", bytes);
    return `doc-${encodeBase64Url(new Uint8Array(digest))}`;
  } catch {
    return `doc-${hashMarkdownText(value)}`;
  }
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
