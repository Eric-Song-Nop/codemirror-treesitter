import { isValidShareId } from "./share.ts";

export const createSharePattern = /^\/api\/shares\/?$/;
export const sharePattern = /^\/api\/shares\/([^/]+)(?:\/(session|rotate|revoke|ws))?\/?$/;
export const requestBodyTooLarge = Symbol("requestBodyTooLarge");

/**
 * Set only by the relay router after a create request has passed the edge
 * rate limiter and the global create quota. The router strips it from every
 * client request, and share rooms refuse creates without it.
 */
export const relayCreateAdmittedHeader = "X-Relay-Create-Admitted";

export type ShareRouteAction = "revoke" | "rotate" | "session" | "ws";

export function shareFromPath(pathname: string) {
  let match = sharePattern.exec(pathname);
  if (!match) return null;

  let shareId: string;
  try {
    shareId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (!isValidShareId(shareId)) return null;
  return {
    action: match[2] as ShareRouteAction | undefined,
    shareId,
  };
}

export function isValidCreateIdempotencyKey(
  value: string | null,
  shareId: string,
): value is string {
  return value != null && value == shareId && isValidShareId(value);
}

export async function readJson(request: Request, maxBytes: number) {
  let declaredLength = request.headers.get("Content-Length");
  if (declaredLength != null && Number(declaredLength) > maxBytes) return requestBodyTooLarge;

  let body = await readTextBody(request, maxBytes);
  if (body === requestBodyTooLarge) return requestBodyTooLarge;

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

async function readTextBody(request: Request, maxBytes: number) {
  if (!request.body) return "";

  let reader = request.body.getReader();
  let decoder = new TextDecoder();
  let byteLength = 0;
  let chunks = "";

  for (;;) {
    let { done, value } = await reader.read();
    if (done) break;

    let chunk = value!;
    byteLength += chunk.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      return requestBodyTooLarge;
    }
    chunks += decoder.decode(chunk, { stream: true });
  }

  chunks += decoder.decode();
  return chunks;
}

/**
 * Parses a comma-separated `ALLOWED_ORIGINS` value. Returns `null` when the
 * value is unset or blank, which keeps the permissive reflect-any-origin mode.
 */
export function parseAllowedOrigins(value: string | null | undefined): ReadonlySet<string> | null {
  if (!value?.trim()) return null;
  let origins = new Set<string>();
  for (let entry of value.split(",")) {
    let origin = normalizeOrigin(entry);
    if (origin) origins.add(origin);
  }
  return origins.size ? origins : null;
}

export function isOriginAllowed(origin: string | null, allowed: ReadonlySet<string> | null) {
  if (!allowed || origin == null) return true;
  let normalized = normalizeOrigin(origin);
  return normalized != null && allowed.has(normalized);
}

export function corsHeaders(
  request: Request,
  allowed: ReadonlySet<string> | null = null,
): Record<string, string> {
  let origin = request.headers.get("Origin");
  let headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    Vary: "Origin",
  };
  if (!allowed) headers["Access-Control-Allow-Origin"] = origin || "*";
  else if (origin && isOriginAllowed(origin, allowed)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** Durable Object responses carry no CORS headers; the router applies them. */
export function jsonResponse(value: unknown, status: number) {
  return Response.json(value, { status });
}

function normalizeOrigin(value: string) {
  let trimmed = value.trim();
  if (!trimmed) return null;
  try {
    let url = new URL(trimmed);
    return url.origin == "null" ? null : url.origin;
  } catch {
    return null;
  }
}
