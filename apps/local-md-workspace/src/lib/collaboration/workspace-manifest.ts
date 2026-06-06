import { LoroDoc, type LoroMap } from "loro-crdt";
import type { WorkspaceBackend } from "@/lib/workspace-backend";

const livemdDirectory = ".livemd";
const legacyManifestPath = `${livemdDirectory}/manifest.json`;
const manifestSnapshotPath = `${livemdDirectory}/workspace.snapshot.b64`;
const filesMapKey = "files";
const defaultTombstoneRetentionMs = 30 * 24 * 60 * 60 * 1000;

export type WorkspaceManifestRecord = {
  deletedAt?: number;
  docId: string;
  kind: "markdown";
  materializedAt?: number;
  materializedHash?: string;
  path: string;
};

export type WorkspaceManifestState = {
  doc: LoroDoc;
  records: WorkspaceManifestRecord[];
};

type ManifestBackend = WorkspaceBackend &
  Required<Pick<WorkspaceBackend, "createDirectory" | "readBytes" | "readTextFile" | "writeBytes">>;

type LegacyWorkspaceManifest = {
  files: Array<{
    docId: string;
    path: string;
  }>;
  schemaVersion: 1;
};

export type WorkspaceTombstoneGcOptions = {
  now?: number;
  retentionMs?: number;
};

export type WorkspaceMetadataRepairResult = {
  removedTombstones: number;
  removedTmp: boolean;
};

export async function ensureManifestFile(backend: WorkspaceBackend, path: string) {
  let manifest = await loadWorkspaceManifest(backend);
  let existing = findLiveRecordByPath(manifest, path);
  if (existing) return { created: false, manifest, record: existing };

  let record: WorkspaceManifestRecord = {
    docId: createDocumentId(),
    kind: "markdown",
    path,
  };
  setManifestRecord(manifest, record);
  await writeWorkspaceManifest(backend, manifest);
  return { created: true, manifest, record };
}

export async function loadWorkspaceManifest(
  backend: WorkspaceBackend,
): Promise<WorkspaceManifestState> {
  ensureManifestBackend(backend);

  let doc = new LoroDoc();
  let snapshot = await readManifestSnapshot(backend);
  if (snapshot) {
    doc.import(snapshot);
    return stateFromDoc(doc);
  }

  let legacy = await readLegacyManifest(backend);
  if (legacy) {
    let state = stateFromDoc(doc);
    for (let file of legacy.files) {
      setManifestRecord(state, {
        docId: file.docId,
        kind: "markdown",
        path: file.path,
      });
    }
    doc.commit();
    await writeWorkspaceManifest(backend, state);
    return stateFromDoc(doc);
  }

  return stateFromDoc(doc);
}

export async function readWorkspaceManifestSnapshotBytes(backend: WorkspaceBackend) {
  ensureManifestBackend(backend);
  return readManifestSnapshot(backend);
}

export async function mergeWorkspaceManifestSnapshot(
  backend: WorkspaceBackend,
  snapshot: Uint8Array,
) {
  ensureManifestBackend(backend);

  let doc = new LoroDoc();
  let current = await readManifestSnapshot(backend);
  if (current) doc.import(current);
  doc.import(snapshot);

  let state = stateFromDoc(doc);
  resolveManifestPathConflicts(state);
  await writeWorkspaceManifest(backend, state);
  return state;
}

export async function renameManifestDirectoryPaths(
  backend: WorkspaceBackend,
  fromDirectory: string,
  toDirectory: string,
) {
  let manifest = await loadWorkspaceManifest(backend);
  let from = normalizeDirectoryPath(fromDirectory);
  let to = normalizeDirectoryPath(toDirectory);
  let changed = false;

  for (let record of manifest.records) {
    if (record.deletedAt != null) continue;
    if (record.path == from || record.path.startsWith(`${from}/`)) {
      setManifestRecord(manifest, {
        ...record,
        path: `${to}${record.path.slice(from.length)}`,
      });
      changed = true;
    }
  }

  if (changed) await writeWorkspaceManifest(backend, manifest);
}

export async function renameManifestFilePath(
  backend: WorkspaceBackend,
  fromPath: string,
  toPath: string,
) {
  let manifest = await loadWorkspaceManifest(backend);
  let record = findLiveRecordByPath(manifest, fromPath);
  if (!record) return;

  setManifestRecord(manifest, { ...record, path: toPath });
  await writeWorkspaceManifest(backend, manifest);
}

export async function tombstoneManifestDirectory(backend: WorkspaceBackend, directoryPath: string) {
  let manifest = await loadWorkspaceManifest(backend);
  let directory = normalizeDirectoryPath(directoryPath);
  let deletedAt = Date.now();
  let changed = false;

  for (let record of manifest.records) {
    if (record.deletedAt != null) continue;
    if (record.path == directory || record.path.startsWith(`${directory}/`)) {
      setManifestRecord(manifest, { ...record, deletedAt });
      changed = true;
    }
  }

  if (changed) await writeWorkspaceManifest(backend, manifest);
}

export async function tombstoneManifestFile(backend: WorkspaceBackend, path: string) {
  let manifest = await loadWorkspaceManifest(backend);
  let record = findLiveRecordByPath(manifest, path);
  if (!record) return;

  setManifestRecord(manifest, { ...record, deletedAt: Date.now() });
  await writeWorkspaceManifest(backend, manifest);
}

export async function gcWorkspaceTombstones(
  backend: WorkspaceBackend,
  options: WorkspaceTombstoneGcOptions = {},
) {
  if (!backend.deleteEntry) return { removed: 0 };

  let manifest = await loadWorkspaceManifest(backend);
  let now = options.now ?? Date.now();
  let retentionMs = options.retentionMs ?? defaultTombstoneRetentionMs;
  let removed = 0;

  for (let record of manifest.records) {
    if (record.deletedAt == null || now - record.deletedAt < retentionMs) continue;

    await deleteIfPresent(backend, documentSnapshotPath(record.docId));
    await deleteIfPresent(backend, documentUpdateLogPath(record.docId));
    getManifestFilesMap(manifest.doc).delete(record.docId);
    removed += 1;
  }

  if (removed) {
    manifest.doc.commit();
    manifest.records = recordsFromDoc(manifest.doc);
    await writeWorkspaceManifest(backend, manifest);
  }

  return { removed };
}

export async function repairWorkspaceCollaborationMetadata(
  backend: WorkspaceBackend,
): Promise<WorkspaceMetadataRepairResult> {
  let removedTmp = false;

  if (backend.deleteEntry) {
    try {
      await backend.deleteEntry(`${livemdDirectory}/tmp`, { recursive: true });
      removedTmp = true;
    } catch (error) {
      if (!isMissingEntryError(error)) throw error;
    }
  }

  let tombstones = await gcWorkspaceTombstones(backend);
  return {
    removedTmp,
    removedTombstones: tombstones.removed,
  };
}

export async function updateManifestMaterialization(
  backend: WorkspaceBackend,
  docId: string,
  details: {
    materializedAt: number;
    materializedHash: string;
  },
) {
  let manifest = await loadWorkspaceManifest(backend);
  let record = manifest.records.find((item) => item.docId == docId);
  if (!record) return;

  setManifestRecord(manifest, { ...record, ...details });
  await writeWorkspaceManifest(backend, manifest);
}

export async function writeWorkspaceManifest(
  backend: WorkspaceBackend,
  manifest: WorkspaceManifestState,
) {
  ensureManifestBackend(backend);
  await backend.createDirectory(livemdDirectory);
  await backend.writeBytes(manifestSnapshotPath, manifest.doc.export({ mode: "snapshot" }));
}

function findLiveRecordByPath(manifest: WorkspaceManifestState, path: string) {
  return manifest.records.find((file) => file.path == path && file.deletedAt == null);
}

function setManifestRecord(manifest: WorkspaceManifestState, record: WorkspaceManifestRecord) {
  getManifestFilesMap(manifest.doc).set(record.docId, record);
  manifest.doc.commit();
  manifest.records = recordsFromDoc(manifest.doc);
}

function resolveManifestPathConflicts(manifest: WorkspaceManifestState) {
  let liveRecords = manifest.records.filter((record) => record.deletedAt == null);
  let recordsByPath = new Map<string, WorkspaceManifestRecord[]>();
  let takenPaths = new Set<string>();
  let updates: WorkspaceManifestRecord[] = [];

  for (let record of liveRecords) {
    let records = recordsByPath.get(record.path);
    if (records) {
      records.push(record);
    } else {
      recordsByPath.set(record.path, [record]);
    }
  }

  for (let [path, records] of recordsByPath) {
    let sorted = [...records].sort((a, b) => a.docId.localeCompare(b.docId));
    let winner = sorted[0];
    if (!winner) continue;

    takenPaths.add(path);
    for (let record of sorted.slice(1)) {
      let conflictPath = manifestPathConflictPath(record.path, record.docId, takenPaths);
      takenPaths.add(conflictPath);
      updates.push({ ...record, path: conflictPath });
    }
  }

  if (!updates.length) return;

  let files = getManifestFilesMap(manifest.doc);
  for (let record of updates) files.set(record.docId, record);
  manifest.doc.commit();
  manifest.records = recordsFromDoc(manifest.doc);
}

function stateFromDoc(doc: LoroDoc): WorkspaceManifestState {
  return { doc, records: recordsFromDoc(doc) };
}

function recordsFromDoc(doc: LoroDoc) {
  let rawRecords = getManifestFilesMap(doc).toJSON();
  return Object.values(rawRecords).filter(isManifestRecord);
}

function getManifestFilesMap(doc: LoroDoc) {
  return doc.getMap(filesMapKey) as LoroMap<Record<string, WorkspaceManifestRecord>>;
}

async function deleteIfPresent(backend: WorkspaceBackend, path: string) {
  if (!backend.deleteEntry) return;

  try {
    await backend.deleteEntry(path);
  } catch (error) {
    if (!isMissingEntryError(error)) throw error;
  }
}

function documentSnapshotPath(docId: string) {
  return `${livemdDirectory}/docs/${docId}.snapshot.b64`;
}

function documentUpdateLogPath(docId: string) {
  return `${livemdDirectory}/docs/${docId}.updates.b64`;
}

async function readManifestSnapshot(backend: ManifestBackend) {
  try {
    return await backend.readBytes(manifestSnapshotPath);
  } catch (error) {
    if (isMissingEntryError(error)) return null;
    throw error;
  }
}

async function readLegacyManifest(backend: ManifestBackend) {
  try {
    return parseLegacyManifest(JSON.parse(await backend.readTextFile(legacyManifestPath)));
  } catch (error) {
    if (isMissingEntryError(error)) return null;
    throw error;
  }
}

function parseLegacyManifest(value: unknown): LegacyWorkspaceManifest | null {
  if (!value || typeof value != "object") return null;
  let record = value as Partial<LegacyWorkspaceManifest>;
  if (record.schemaVersion != 1 || !Array.isArray(record.files)) return null;

  let files = record.files.filter(isLegacyManifestFile);
  return { files, schemaVersion: 1 };
}

function isLegacyManifestFile(value: unknown): value is LegacyWorkspaceManifest["files"][number] {
  if (!value || typeof value != "object") return false;
  let record = value as Partial<LegacyWorkspaceManifest["files"][number]>;
  return typeof record.docId == "string" && typeof record.path == "string";
}

function isManifestRecord(value: unknown): value is WorkspaceManifestRecord {
  if (!value || typeof value != "object") return false;
  let record = value as Partial<WorkspaceManifestRecord>;
  return (
    record.kind == "markdown" &&
    typeof record.docId == "string" &&
    typeof record.path == "string" &&
    (record.deletedAt == null || typeof record.deletedAt == "number")
  );
}

function ensureManifestBackend(backend: WorkspaceBackend): asserts backend is ManifestBackend {
  if (
    !backend.createDirectory ||
    !backend.readBytes ||
    !backend.readTextFile ||
    !backend.writeBytes
  ) {
    throw new Error("This workspace backend does not support local-first collaboration manifests.");
  }
}

function normalizeDirectoryPath(path: string) {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function manifestPathConflictPath(path: string, docId: string, takenPaths: Set<string>) {
  let slash = path.lastIndexOf("/");
  let directory = slash == -1 ? "" : path.slice(0, slash + 1);
  let fileName = slash == -1 ? path : path.slice(slash + 1);
  let extension = fileName.match(/\.md$/i)?.[0] ?? ".md";
  let stem = fileName.slice(0, fileName.length - extension.length) || "document";
  let suffix = docId.replace(/[^a-z0-9-]/gi, "").slice(0, 8) || "conflict";

  for (let attempt = 0; attempt < 1000; attempt++) {
    let attemptSuffix = attempt ? `-${attempt + 1}` : "";
    let conflictPath = `${directory}${stem}.path-conflict-${suffix}${attemptSuffix}${extension}`;
    if (!takenPaths.has(conflictPath)) return conflictPath;
  }

  throw new Error("Could not allocate a manifest path conflict file.");
}

function createDocumentId() {
  return crypto.randomUUID();
}

function isMissingEntryError(error: unknown) {
  if (error instanceof DOMException) return error.name == "NotFoundError";
  let message = error instanceof Error ? error.message : String(error);
  return /not.?found|not_found|404/i.test(message);
}
