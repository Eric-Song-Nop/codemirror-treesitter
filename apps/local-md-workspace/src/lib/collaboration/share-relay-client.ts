export type RelayShareCreateRequest = {
  displayName: string;
  expiresAt: number | null;
  guestSecretHash: string;
  hostSecretHash: string;
  shareId: string;
  snapshot: Uint8Array;
};

export type RelayShareRole = "guest" | "host";

export type RelayShareSession = {
  displayName: string;
  expiresAt: number;
  guestCount: number;
  hostOnline: boolean;
  peerCount: number;
  pendingHostSave: boolean;
  role: RelayShareRole;
  sessionToken: string;
  shareExpiresAt: number | null;
  shareId: string;
};

export type RelayShareRotateRequest = {
  expiresAt: number | null;
  hostSecret: string;
  nextGuestSecretHash: string;
};

export type RelayShareRotateResult = {
  expiresAt: number | null;
  shareId: string;
};

export type RelayShareRevokeResult = {
  revokedAt: number;
  shareId: string;
};

export async function createRelayShare(
  relayOrigin: string | null | undefined,
  request: RelayShareCreateRequest,
  fetchImpl: typeof fetch = fetch,
) {
  let origin = normalizeRelayOrigin(relayOrigin);
  if (!origin) throw new Error("Shared file relay is not configured.");

  let body = JSON.stringify({
    displayName: request.displayName,
    expiresAt: request.expiresAt,
    guestSecretHash: request.guestSecretHash,
    hostSecretHash: request.hostSecretHash,
    shareId: request.shareId,
    snapshot: encodeBase64(request.snapshot),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(new URL("/api/shares", origin), {
        body,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": request.shareId,
        },
        method: "POST",
      });
    } catch (error) {
      if (attempt == 0) continue;
      throw error;
    }

    if (response.ok) return;
    if (attempt == 0 && response.status >= 500) continue;
    throw new Error(`Could not create shared file (${response.status}).`);
  }
}

export async function createRelayShareSession(
  relayOrigin: string | null | undefined,
  shareId: string,
  role: RelayShareRole,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayShareSession> {
  let origin = normalizeRelayOrigin(relayOrigin);
  if (!origin) throw new Error("Shared file relay is not configured.");

  let response = await fetchImpl(
    new URL(`/api/shares/${encodeURIComponent(shareId)}/session`, origin),
    {
      body: JSON.stringify({ role, secret }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Could not join shared file (${response.status}).`);
  }

  return parseRelayShareSession(await response.json());
}

export async function rotateRelayShare(
  relayOrigin: string | null | undefined,
  shareId: string,
  request: RelayShareRotateRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayShareRotateResult> {
  let origin = normalizeRelayOrigin(relayOrigin);
  if (!origin) throw new Error("Shared file relay is not configured.");

  let response = await fetchImpl(
    new URL(`/api/shares/${encodeURIComponent(shareId)}/rotate`, origin),
    {
      body: JSON.stringify({
        expiresAt: request.expiresAt,
        hostSecret: request.hostSecret,
        nextGuestSecretHash: request.nextGuestSecretHash,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Could not rotate shared file link (${response.status}).`);
  }

  return parseRelayShareRotateResult(await response.json());
}

export async function revokeRelayShare(
  relayOrigin: string | null | undefined,
  shareId: string,
  hostSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayShareRevokeResult> {
  let origin = normalizeRelayOrigin(relayOrigin);
  if (!origin) throw new Error("Shared file relay is not configured.");

  let response = await fetchImpl(
    new URL(`/api/shares/${encodeURIComponent(shareId)}/revoke`, origin),
    {
      body: JSON.stringify({ hostSecret }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Could not stop sharing this file (${response.status}).`);
  }

  return parseRelayShareRevokeResult(await response.json());
}

export function shareRelayWebSocketUrl(
  relayOrigin: string | null | undefined,
  shareId: string,
  clientId: string,
) {
  let origin = normalizeRelayOrigin(relayOrigin);
  if (!origin) throw new Error("Shared file relay is not configured.");

  let url = new URL(`/api/shares/${encodeURIComponent(shareId)}/ws`, origin);
  url.protocol = url.protocol == "http:" || url.protocol == "ws:" ? "ws:" : "wss:";
  url.search = new URLSearchParams({ clientId }).toString();
  return url.toString();
}

export function configuredShareRelayOrigin() {
  return import.meta.env.VITE_LOCAL_MD_SHARE_RELAY_ORIGIN?.trim() || "";
}

function normalizeRelayOrigin(value: string | null | undefined) {
  let trimmed = value?.trim();
  if (!trimmed) return "";

  let normalized = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(normalized).origin;
  } catch {
    return "";
  }
}

function encodeBase64(bytes: Uint8Array) {
  let chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function parseRelayShareSession(value: unknown): RelayShareSession {
  if (!value || typeof value != "object") throw new Error("Invalid shared file session.");
  let session = value as Partial<RelayShareSession>;
  if (
    typeof session.displayName != "string" ||
    typeof session.expiresAt != "number" ||
    typeof session.hostOnline != "boolean" ||
    (session.role != "guest" && session.role != "host") ||
    typeof session.sessionToken != "string" ||
    (session.shareExpiresAt != null && typeof session.shareExpiresAt != "number") ||
    typeof session.shareId != "string"
  ) {
    throw new Error("Invalid shared file session.");
  }

  return {
    displayName: session.displayName,
    expiresAt: session.expiresAt,
    guestCount: typeof session.guestCount == "number" ? session.guestCount : 0,
    hostOnline: session.hostOnline,
    peerCount: typeof session.peerCount == "number" ? session.peerCount : 0,
    pendingHostSave: typeof session.pendingHostSave == "boolean" ? session.pendingHostSave : false,
    role: session.role,
    sessionToken: session.sessionToken,
    shareExpiresAt: session.shareExpiresAt ?? null,
    shareId: session.shareId,
  };
}

function parseRelayShareRotateResult(value: unknown): RelayShareRotateResult {
  if (!value || typeof value != "object") throw new Error("Invalid shared file rotation.");
  let result = value as Partial<RelayShareRotateResult>;
  if (
    (result.expiresAt != null && typeof result.expiresAt != "number") ||
    typeof result.shareId != "string"
  ) {
    throw new Error("Invalid shared file rotation.");
  }

  return {
    expiresAt: result.expiresAt ?? null,
    shareId: result.shareId,
  };
}

function parseRelayShareRevokeResult(value: unknown): RelayShareRevokeResult {
  if (!value || typeof value != "object") throw new Error("Invalid shared file revocation.");
  let result = value as Partial<RelayShareRevokeResult>;
  if (typeof result.revokedAt != "number" || typeof result.shareId != "string") {
    throw new Error("Invalid shared file revocation.");
  }

  return {
    revokedAt: result.revokedAt,
    shareId: result.shareId,
  };
}
