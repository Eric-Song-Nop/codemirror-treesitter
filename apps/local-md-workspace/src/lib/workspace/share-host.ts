import { readOwnerShareHostSecret, type OwnerShareRecord } from "@/lib/collaboration/share-storage";
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

/** Reads the tab-scoped host secret; see `readOwnerShareHostSecret`. */
export function readHostSecret(record: OwnerShareRecord) {
  return readOwnerShareHostSecret(record);
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
