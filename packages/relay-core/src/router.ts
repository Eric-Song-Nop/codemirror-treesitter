import { LoroDoc } from "loro-crdt";
import {
  corsHeaders,
  createSharePattern,
  isOriginAllowed,
  isValidCreateIdempotencyKey,
  parseAllowedOrigins,
  readJson,
  relayCreateAdmittedHeader,
  requestBodyTooLarge,
  shareFromPath,
} from "./http.ts";
import { decodeBase64, parseCreateShareRequest } from "./share.ts";
import { maxCreateShareBodyBytes, maxSnapshotBytes } from "./share-limits.ts";

type RelayRateLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type RelayRoomStub = {
  fetch(request: Request): Promise<Response>;
};

type RelayCreateQuotaStub = {
  reserve(shareId: string, decodedSnapshotBytes: number): Promise<unknown>;
};

/** Worker bindings consumed by {@link handleRelayRequest}. */
export type RelayBindings = {
  /** Comma-separated origin allowlist. Blank or unset reflects any origin. */
  allowedOrigins?: string | null;
  createQuota: { getByName(name: string): RelayCreateQuotaStub };
  createRateLimiter: RelayRateLimiter;
  rooms: { getByName(name: string): RelayRoomStub };
  sessionRateLimiter: RelayRateLimiter;
  websocketRateLimiter: RelayRateLimiter;
};

export const globalCreateQuotaName = "global-create-quota";

/**
 * Shared Worker router for share rooms. Every share is created through one
 * rate-limited, quota-reserved `POST /api/shares` entry point; session and
 * WebSocket routes are edge rate-limited before a room Durable Object wakes.
 */
export async function handleRelayRequest(
  request: Request,
  bindings: RelayBindings,
): Promise<Response> {
  let allowedOrigins = parseAllowedOrigins(bindings.allowedOrigins);
  let response = await routeRelayRequest(request, bindings, allowedOrigins);
  return withCors(response, request, allowedOrigins);
}

async function routeRelayRequest(
  request: Request,
  bindings: RelayBindings,
  allowedOrigins: ReadonlySet<string> | null,
): Promise<Response> {
  let url = new URL(request.url);
  if (request.method == "OPTIONS" && url.pathname.startsWith("/api/")) {
    return new Response(null);
  }

  if (createSharePattern.test(url.pathname) && request.method == "POST") {
    return createShare(request, url, bindings);
  }

  let share = shareFromPath(url.pathname);
  if (!share) return new Response("Not Found", { status: 404 });

  // `POST /api/shares/:id` used to reach the room's create handler directly,
  // bypassing the rate limiter and the global quota.
  if (!share.action) return Response.json({ error: "Not found" }, { status: 404 });

  if (share.action == "session") {
    if (request.method != "POST") return Response.json({ error: "Not found" }, { status: 404 });
    if (
      !(await allowPublicApiRequest(
        request,
        bindings.sessionRateLimiter,
        "share-session",
        share.shareId,
      ))
    ) {
      return Response.json({ error: "Share session rate limit exceeded" }, { status: 429 });
    }
  }
  if (share.action == "ws") {
    if (request.method != "GET") return Response.json({ error: "Not found" }, { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (!isOriginAllowed(request.headers.get("Origin"), allowedOrigins)) {
      return Response.json({ error: "Origin not allowed" }, { status: 403 });
    }
    if (
      !(await allowPublicApiRequest(
        request,
        bindings.websocketRateLimiter,
        "share-websocket",
        share.shareId,
      ))
    ) {
      return Response.json({ error: "Share connection rate limit exceeded" }, { status: 429 });
    }
  }

  return bindings.rooms.getByName(share.shareId).fetch(withoutInternalHeaders(request));
}

async function createShare(request: Request, url: URL, bindings: RelayBindings) {
  if (!(await allowPublicApiRequest(request, bindings.createRateLimiter, "create-share", "all"))) {
    return Response.json({ error: "Share creation rate limit exceeded" }, { status: 429 });
  }

  let json = await readJson(request, maxCreateShareBodyBytes);
  if (json === requestBodyTooLarge) {
    return Response.json({ error: "Request too large" }, { status: 413 });
  }

  let body = parseCreateShareRequest(json);
  if (!body) return Response.json({ error: "Invalid share" }, { status: 400 });
  if (!isValidCreateIdempotencyKey(request.headers.get("Idempotency-Key"), body.shareId)) {
    return Response.json({ error: "Invalid idempotency key" }, { status: 400 });
  }

  let snapshot = decodeBase64(body.snapshot);
  if (!snapshot) return Response.json({ error: "Invalid snapshot" }, { status: 400 });
  if (snapshot.byteLength > maxSnapshotBytes) {
    return Response.json({ error: "Snapshot too large" }, { status: 413 });
  }
  if (!isValidLoroSnapshot(snapshot)) {
    return Response.json({ error: "Invalid snapshot" }, { status: 400 });
  }

  let quotaReservation: unknown;
  try {
    quotaReservation = await bindings.createQuota
      .getByName(globalCreateQuotaName)
      .reserve(body.shareId, snapshot.byteLength);
  } catch (error: unknown) {
    console.error("Relay create quota reservation failed", error);
    return Response.json({ error: "Share creation temporarily unavailable" }, { status: 503 });
  }
  let quotaStatus =
    quotaReservation && typeof quotaReservation == "object"
      ? (quotaReservation as { status?: unknown }).status
      : null;
  if (quotaStatus == "exhausted") {
    return Response.json({ error: "Share creation quota exceeded" }, { status: 429 });
  }
  if (quotaStatus == "conflict") {
    return Response.json({ error: "Share quota reservation conflicts" }, { status: 409 });
  }
  if (quotaStatus != "reserved" && quotaStatus != "replayed") {
    return Response.json({ error: "Share creation temporarily unavailable" }, { status: 503 });
  }

  let shareUrl = new URL(`/api/shares/${encodeURIComponent(body.shareId)}`, url);
  return bindings.rooms.getByName(body.shareId).fetch(
    new Request(shareUrl, {
      body: JSON.stringify(body),
      headers: admittedCreateHeaders(request),
      method: "POST",
    }),
  );
}

function admittedCreateHeaders(request: Request) {
  let headers = new Headers({ "Content-Type": "application/json" });
  let idempotencyKey = request.headers.get("Idempotency-Key");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  let origin = request.headers.get("Origin");
  if (origin) headers.set("Origin", origin);
  headers.set(relayCreateAdmittedHeader, "1");
  return headers;
}

function withoutInternalHeaders(request: Request) {
  if (!request.headers.has(relayCreateAdmittedHeader)) return request;
  let headers = new Headers(request.headers);
  headers.delete(relayCreateAdmittedHeader);
  return new Request(request, { headers });
}

function withCors(
  response: Response,
  request: Request,
  allowedOrigins: ReadonlySet<string> | null,
) {
  // WebSocket upgrades carry no CORS headers and cannot be re-wrapped.
  if (response.status == 101) return response;
  let next = new Response(response.body, response);
  next.headers.delete("Access-Control-Allow-Origin");
  for (let [name, value] of Object.entries(corsHeaders(request, allowedOrigins))) {
    next.headers.set(name, value);
  }
  return next;
}

function isValidLoroSnapshot(snapshot: Uint8Array) {
  let doc = new LoroDoc();
  try {
    doc.import(snapshot);
    return true;
  } catch {
    return false;
  } finally {
    doc.free();
  }
}

async function allowPublicApiRequest(
  request: Request,
  limiter: RelayRateLimiter,
  route: string,
  resource: string,
) {
  let actor =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("Origin") ??
    request.headers.get("Referer") ??
    "unknown";
  let actorResult = await limiter.limit({ key: `${route}:actor:${actor}` });
  if (!actorResult.success) return false;

  let resourceResult = await limiter.limit({ key: `${route}:resource:${resource}` });
  if (!resourceResult.success || resource == "all") return resourceResult.success;

  let aggregateResult = await limiter.limit({ key: `${route}:resource:all` });
  return aggregateResult.success;
}
