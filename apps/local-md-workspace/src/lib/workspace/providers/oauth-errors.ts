import { Schema } from "effect";

/**
 * Typed OAuth failures. `message` keeps the exact user-facing English text the
 * UI and i18n catalog already map (for example "Dropbox authorization popup was
 * blocked."); `reason`/`request` let Effect code branch without parsing it.
 */
export class OAuthAuthorizationError extends Schema.TaggedError<OAuthAuthorizationError>()(
  "OAuthAuthorizationError",
  {
    message: Schema.String,
    provider: Schema.String,
    reason: Schema.Literals([
      "client-id-required",
      "closed",
      "denied",
      "failed",
      "missing-code",
      "popup-blocked",
      "state-mismatch",
      "state-missing",
      "timed-out",
    ]),
  },
) {}

/** An OAuth or provider account HTTP request failed. */
export class OAuthRequestError extends Schema.TaggedError<OAuthRequestError>()(
  "OAuthRequestError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    provider: Schema.String,
    request: Schema.Literals(["account-identity", "token-exchange"]),
    /** True for network failures, 429, and 5xx responses. */
    retryable: Schema.Boolean,
    status: Schema.optional(Schema.Number),
  },
) {}

/** Re-authorization returned credentials for a different provider account. */
export class WorkspaceAccountChanged extends Schema.TaggedError<WorkspaceAccountChanged>()(
  "WorkspaceAccountChanged",
  { message: Schema.String, provider: Schema.String },
) {}

export type OAuthError = OAuthAuthorizationError | OAuthRequestError;

export function isRetryableHttpStatus(status: number) {
  return status == 429 || status >= 500;
}
