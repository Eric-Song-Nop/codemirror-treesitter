type MarkdownDocumentRuntime = typeof import("./markdown-document-runtime.ts");

let loadedRuntime: MarkdownDocumentRuntime | null = null;
let runtimeRequest: Promise<MarkdownDocumentRuntime> | null = null;

export { hashMarkdownText } from "./markdown-hash.ts";
export type {
  CollabDocumentMaterialization,
  CollabDocumentState,
  CollabExternalEditResolution,
  CollabSourceImportResult,
  CollabSourceState,
  MaterializeCollabDocumentResult,
} from "./markdown-document-runtime.ts";

export async function openMarkdownCollabDocument(
  ...args: Parameters<MarkdownDocumentRuntime["openMarkdownCollabDocument"]>
) {
  return (await loadMarkdownDocumentRuntime()).openMarkdownCollabDocument(...args);
}

export function getCollabDocumentValue(
  ...args: Parameters<MarkdownDocumentRuntime["getCollabDocumentValue"]>
) {
  return requireMarkdownDocumentRuntime().getCollabDocumentValue(...args);
}

export function collabDocumentNeedsSourceWrite(
  ...args: Parameters<MarkdownDocumentRuntime["collabDocumentNeedsSourceWrite"]>
) {
  return requireMarkdownDocumentRuntime().collabDocumentNeedsSourceWrite(...args);
}

export async function saveCollabDocumentSnapshot(
  ...args: Parameters<MarkdownDocumentRuntime["saveCollabDocumentSnapshot"]>
) {
  return requireMarkdownDocumentRuntime().saveCollabDocumentSnapshot(...args);
}

export function scheduleCollabDocumentSnapshotFlush(
  ...args: Parameters<MarkdownDocumentRuntime["scheduleCollabDocumentSnapshotFlush"]>
) {
  return requireMarkdownDocumentRuntime().scheduleCollabDocumentSnapshotFlush(...args);
}

export async function flushCollabDocumentSnapshot(
  ...args: Parameters<MarkdownDocumentRuntime["flushCollabDocumentSnapshot"]>
) {
  return requireMarkdownDocumentRuntime().flushCollabDocumentSnapshot(...args);
}

export async function savePendingCollabDocumentUpdates(
  ...args: Parameters<MarkdownDocumentRuntime["savePendingCollabDocumentUpdates"]>
) {
  return requireMarkdownDocumentRuntime().savePendingCollabDocumentUpdates(...args);
}

export function schedulePendingCollabDocumentUpdateFlush(
  ...args: Parameters<MarkdownDocumentRuntime["schedulePendingCollabDocumentUpdateFlush"]>
) {
  return requireMarkdownDocumentRuntime().schedulePendingCollabDocumentUpdateFlush(...args);
}

export async function flushPendingCollabDocumentUpdates(
  ...args: Parameters<MarkdownDocumentRuntime["flushPendingCollabDocumentUpdates"]>
) {
  return requireMarkdownDocumentRuntime().flushPendingCollabDocumentUpdates(...args);
}

export async function flushCollabDocumentPersistence(
  ...args: Parameters<MarkdownDocumentRuntime["flushCollabDocumentPersistence"]>
) {
  return requireMarkdownDocumentRuntime().flushCollabDocumentPersistence(...args);
}

export async function materializeCollabDocument(
  ...args: Parameters<MarkdownDocumentRuntime["materializeCollabDocument"]>
) {
  return requireMarkdownDocumentRuntime().materializeCollabDocument(...args);
}

export async function acknowledgeCollabDocumentSourceSaved(
  ...args: Parameters<MarkdownDocumentRuntime["acknowledgeCollabDocumentSourceSaved"]>
) {
  return requireMarkdownDocumentRuntime().acknowledgeCollabDocumentSourceSaved(...args);
}

export function captureCollabDocumentMaterialization(
  ...args: Parameters<MarkdownDocumentRuntime["captureCollabDocumentMaterialization"]>
) {
  return requireMarkdownDocumentRuntime().captureCollabDocumentMaterialization(...args);
}

export async function ingestExternalMarkdownEdit(
  ...args: Parameters<MarkdownDocumentRuntime["ingestExternalMarkdownEdit"]>
) {
  return requireMarkdownDocumentRuntime().ingestExternalMarkdownEdit(...args);
}

export async function ingestExternalMarkdownObservation(
  ...args: Parameters<MarkdownDocumentRuntime["ingestExternalMarkdownObservation"]>
) {
  return requireMarkdownDocumentRuntime().ingestExternalMarkdownObservation(...args);
}

export async function resolveCollabRecoveryUseExternal(
  ...args: Parameters<MarkdownDocumentRuntime["resolveCollabRecoveryUseExternal"]>
) {
  return requireMarkdownDocumentRuntime().resolveCollabRecoveryUseExternal(...args);
}

async function loadMarkdownDocumentRuntime() {
  if (loadedRuntime) return loadedRuntime;
  runtimeRequest ??= import("./markdown-document-runtime.ts");

  try {
    loadedRuntime = await runtimeRequest;
    return loadedRuntime;
  } catch (error) {
    runtimeRequest = null;
    throw error;
  }
}

function requireMarkdownDocumentRuntime() {
  if (!loadedRuntime) {
    throw new Error("The collaboration document runtime has not been loaded.");
  }
  return loadedRuntime;
}
