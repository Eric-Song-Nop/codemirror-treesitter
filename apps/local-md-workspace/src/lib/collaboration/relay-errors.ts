import { Schema } from "effect";

/**
 * Typed shared-file relay failures. `message` keeps the exact user-facing text
 * the UI shows and the i18n catalog localizes (for example "Could not join
 * shared file (403)."), so Promise callers keep working unchanged.
 */

/** No relay origin is configured, or it is malformed. */
export class ShareRelayNotConfigured extends Schema.TaggedError<ShareRelayNotConfigured>()(
  "ShareRelayNotConfigured",
  { message: Schema.String },
) {
  static readonly make = () =>
    new ShareRelayNotConfigured({ message: "Shared file relay is not configured." });
}

export type ShareRelayOperation = "create" | "join" | "revoke" | "rotate";

/**
 * A relay HTTP request failed. `reason` classifies the status: `unauthorized`
 * (401/403), `expired` (410), `rate-limited` (429), `unavailable` (5xx or a
 * network failure), or `rejected` (any other status).
 */
export class ShareRelayRequestError extends Schema.TaggedError<ShareRelayRequestError>()(
  "ShareRelayRequestError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    operation: Schema.Literals(["create", "join", "revoke", "rotate"]),
    reason: Schema.Literals(["expired", "rate-limited", "rejected", "unauthorized", "unavailable"]),
    status: Schema.optional(Schema.Number),
  },
) {
  get retryable() {
    return this.reason == "unavailable";
  }
}

/** The relay answered with a payload or frame this client cannot accept. */
export class ShareRelayProtocolError extends Schema.TaggedError<ShareRelayProtocolError>()(
  "ShareRelayProtocolError",
  { message: Schema.String },
) {}

/** The relay rejected the WebSocket session (policy close). */
export class ShareRelayUnauthorized extends Schema.TaggedError<ShareRelayUnauthorized>()(
  "ShareRelayUnauthorized",
  { message: Schema.String },
) {}

/** The session expired and no refresh is available. */
export class ShareRelaySessionExpired extends Schema.TaggedError<ShareRelaySessionExpired>()(
  "ShareRelaySessionExpired",
  { message: Schema.String },
) {}

/** Local and relay state diverged; the document must be reloaded. */
export class ShareRelayResyncRequired extends Schema.TaggedError<ShareRelayResyncRequired>()(
  "ShareRelayResyncRequired",
  {},
) {}

/** The WebSocket closed; `opened` tells whether it had been established. */
export class ShareRelayConnectionLost extends Schema.TaggedError<ShareRelayConnectionLost>()(
  "ShareRelayConnectionLost",
  { code: Schema.Number, opened: Schema.Boolean },
) {}

export function relayRequestReason(status: number): ShareRelayRequestError["reason"] {
  if (status == 401 || status == 403) return "unauthorized";
  if (status == 410) return "expired";
  if (status == 429) return "rate-limited";
  if (status >= 500) return "unavailable";
  return "rejected";
}

/** The relay asked for a new session token before it accepts more traffic. */
export class ShareRelaySessionRefreshRequired extends Schema.TaggedError<ShareRelaySessionRefreshRequired>()(
  "ShareRelaySessionRefreshRequired",
  {},
) {}

/** Obtaining a new session token failed; `message` is the refresh failure's. */
export class ShareRelaySessionRefreshFailed extends Schema.TaggedError<ShareRelaySessionRefreshFailed>()(
  "ShareRelaySessionRefreshFailed",
  { cause: Schema.Defect(), message: Schema.String },
) {}
