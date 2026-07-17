import { WireKind, type WireMessage } from "./protocol.ts";

export const maxCreateShareBodyBytes = 2 * 1024 * 1024;
export const maxShareControlBodyBytes = 64 * 1024;
export const maxSnapshotBytes = 1024 * 1024;
export const maxDocumentUpdateBytes = 256 * 1024;
export const maxPresencePayloadBytes = 32 * 1024;
export const maxHostSaveAckPayloadBytes = 16 * 1024;
export const maxBatchMessages = 64;
export const maxBatchPayloadBytes = maxSnapshotBytes;
export const maxFrameBytes = maxBatchPayloadBytes + maxBatchMessages * 5 + 1;
export const maxSharePeers = 64;
export const maxShareGuestPeers = maxSharePeers - 1;
export const maxShareSessions = 64;
export const maxShareTtlMs = 30 * 24 * 60 * 60 * 1000;
export const maxUpdateFrameBurst = 60;
export const maxUpdateFramesPerMinute = 120;

export type WireFrameLimitResult =
  | { ok: true }
  | {
      closeCode: number;
      ok: false;
      reason: string;
    };

export function estimatedDecodedBase64Bytes(value: string) {
  let normalized = value.trim();
  if (!normalized || normalized.length % 4 == 1) return null;

  let padding = 0;
  if (normalized.endsWith("==")) padding = 2;
  else if (normalized.endsWith("=")) padding = 1;

  return Math.floor((normalized.length * 3) / 4) - padding;
}

export function isShareExpirationWithinLimit(
  expiresAt: number | null | undefined,
  now = Date.now(),
) {
  return expiresAt != null && expiresAt > now && expiresAt <= now + maxShareTtlMs;
}

export function validateWireFrameLimits(
  frameByteLength: number,
  messages: readonly WireMessage[],
): WireFrameLimitResult {
  if (frameByteLength > maxFrameBytes) {
    return { closeCode: 1009, ok: false, reason: "Collaboration frame is too large" };
  }
  if (messages.length > maxBatchMessages) {
    return { closeCode: 1008, ok: false, reason: "Collaboration batch has too many messages" };
  }

  let payloadBytes = 0;
  for (let message of messages) {
    payloadBytes += message.payload.byteLength;
    if (payloadBytes > maxBatchPayloadBytes) {
      return { closeCode: 1009, ok: false, reason: "Collaboration batch is too large" };
    }

    if (message.kind == WireKind.Doc && message.payload.byteLength > maxDocumentUpdateBytes) {
      return { closeCode: 1009, ok: false, reason: "Document update is too large" };
    }
    if (message.kind == WireKind.Snapshot && message.payload.byteLength > maxSnapshotBytes) {
      return { closeCode: 1009, ok: false, reason: "Document snapshot is too large" };
    }
    if (message.kind == WireKind.Presence && message.payload.byteLength > maxPresencePayloadBytes) {
      return { closeCode: 1009, ok: false, reason: "Presence update is too large" };
    }
    if (
      message.kind == WireKind.HostSaveAck &&
      message.payload.byteLength > maxHostSaveAckPayloadBytes
    ) {
      return { closeCode: 1009, ok: false, reason: "Host save acknowledgement is too large" };
    }
  }

  return { ok: true };
}
