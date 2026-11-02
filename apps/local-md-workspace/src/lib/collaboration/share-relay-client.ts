import { Effect, Predicate, Schedule } from "effect";
import {
  relayRequestReason,
  ShareRelayNotConfigured,
  ShareRelayProtocolError,
  ShareRelayRequestError,
  type ShareRelayOperation,
} from "./relay-errors.ts";

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

/** One immediate replay for a create whose response was lost (network or 5xx). */
export const relayShareCreateRetrySchedule = Schedule.recurs(1);

/**
 * Creates the relay share. The create is idempotent (`Idempotency-Key` is the
 * share id), so a network failure or 5xx is replayed once.
 */
export const createRelayShare = Effect.fn("createRelayShare")(function* (
  relayOrigin: string | null | undefined,
  request: RelayShareCreateRequest,
  fetchImpl: typeof fetch = fetch,
) {
  let origin = yield* requireRelayOrigin(relayOrigin);
  let body = JSON.stringify({
    displayName: request.displayName,
    expiresAt: request.expiresAt,
    guestSecretHash: request.guestSecretHash,
    hostSecretHash: request.hostSecretHash,
    shareId: request.shareId,
    snapshot: encodeBase64(request.snapshot),
  });
  yield* relayRequest("create", fetchImpl, new URL("/api/shares", origin), {
    body,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": request.shareId,
    },
    method: "POST",
  }).pipe(
    Effect.retry(
      relayShareCreateRetrySchedule.pipe(
        Schedule.setInputType<ShareRelayRequestError>(),
        Schedule.while(({ input }) => input.retryable),
      ),
    ),
  );
});

export const createRelayShareSession = Effect.fn("createRelayShareSession")(function* (
  relayOrigin: string | null | undefined,
  shareId: string,
  role: RelayShareRole,
  secret: string,
  fetchImpl: typeof fetch = fetch,
) {
  let origin = yield* requireRelayOrigin(relayOrigin);
  let response = yield* relayRequest(
    "join",
    fetchImpl,
    new URL(`/api/shares/${encodeURIComponent(shareId)}/session`, origin),
    {
      body: JSON.stringify({ role, secret }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  return yield* parseResponse(response, parseRelayShareSession);
});

export const rotateRelayShare = Effect.fn("rotateRelayShare")(function* (
  relayOrigin: string | null | undefined,
  shareId: string,
  request: RelayShareRotateRequest,
  fetchImpl: typeof fetch = fetch,
) {
  let origin = yield* requireRelayOrigin(relayOrigin);
  let response = yield* relayRequest(
    "rotate",
    fetchImpl,
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
  return yield* parseResponse(response, parseRelayShareRotateResult);
});

export const revokeRelayShare = Effect.fn("revokeRelayShare")(function* (
  relayOrigin: string | null | undefined,
  shareId: string,
  hostSecret: string,
  fetchImpl: typeof fetch = fetch,
) {
  let origin = yield* requireRelayOrigin(relayOrigin);
  let response = yield* relayRequest(
    "revoke",
    fetchImpl,
    new URL(`/api/shares/${encodeURIComponent(shareId)}/revoke`, origin),
    {
      body: JSON.stringify({ hostSecret }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  return yield* parseResponse(response, parseRelayShareRevokeResult);
});

const failureMessages: Record<ShareRelayOperation, (status: number) => string> = {
  create: (status) => `Could not create shared file (${status}).`,
  join: (status) => `Could not join shared file (${status}).`,
  revoke: (status) => `Could not stop sharing this file (${status}).`,
  rotate: (status) => `Could not rotate shared file link (${status}).`,
};

function requireRelayOrigin(relayOrigin: string | null | undefined) {
  let origin = normalizeRelayOrigin(relayOrigin);
  return origin ? Effect.succeed(origin) : Effect.fail(ShareRelayNotConfigured.make());
}

/**
 * Sends one relay request. Interruption aborts it. A network failure is an
 * `unavailable` request error that keeps the browser's message; a non-2xx
 * response fails with the operation's user-facing message.
 */
function relayRequest(
  operation: ShareRelayOperation,
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
) {
  return Effect.tryPromise({
    catch: (cause) =>
      new ShareRelayRequestError({
        cause,
        message: Predicate.isError(cause) ? cause.message : String(cause),
        operation,
        reason: "unavailable",
      }),
    try: (signal) => fetchImpl(url, { ...init, signal }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response)
        : Effect.fail(
            new ShareRelayRequestError({
              message: failureMessages[operation](response.status),
              operation,
              reason: relayRequestReason(response.status),
              status: response.status,
            }),
          ),
    ),
  );
}

function parseResponse<T>(response: Response, parse: (value: unknown) => T) {
  return Effect.tryPromise({
    catch: () =>
      new ShareRelayProtocolError({ message: "Shared file relay sent an invalid response." }),
    try: () => response.json() as Promise<unknown>,
  }).pipe(
    Effect.flatMap((value) =>
      Effect.try({
        catch: (cause) =>
          new ShareRelayProtocolError({
            message: Predicate.isError(cause) ? cause.message : String(cause),
          }),
        try: () => parse(value),
      }),
    ),
  );
}

export function shareRelayWebSocketUrl(
  relayOrigin: string | null | undefined,
  shareId: string,
  clientId: string,
) {
  let origin = normalizeRelayOrigin(relayOrigin);
  if (!origin) throw ShareRelayNotConfigured.make();

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
