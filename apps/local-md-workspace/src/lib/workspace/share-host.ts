import type { VersionVector } from "loro-crdt";
import { hostSecretStorageKey, type OwnerShareRecord } from "@/lib/collaboration/share-storage";
import type { ShareRelayStatus } from "@/lib/collaboration/share-relay-connection";
import type { ActiveOwnerShareRecord } from "@/lib/workspace/types";

export function mergeOwnerShareStatus(
  record: ActiveOwnerShareRecord,
  status: ShareRelayStatus,
): ActiveOwnerShareRecord {
  return {
    ...record,
    expiresAt: status.expiresAt,
    guestCount: status.guestCount,
    hostOnline: status.hostOnline,
    peerCount: status.peerCount,
    pendingHostSave: status.pendingHostSave,
  };
}

export function readHostSecret(record: OwnerShareRecord) {
  try {
    return (
      localStorage.getItem(record.hostSecretRef) ??
      localStorage.getItem(hostSecretStorageKey(record.shareId))
    );
  } catch {
    return null;
  }
}

export function serializeVersionVector(version: VersionVector) {
  return [...version.toJSON()].map(([peer, counter]) => [String(peer), counter]);
}

export function getOrCreateOwnerShareClientId() {
  try {
    let existing = sessionStorage.getItem("local-md-workspace:owner-share-client-id");
    if (existing) return existing;
    let next = crypto.randomUUID();
    sessionStorage.setItem("local-md-workspace:owner-share-client-id", next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}
