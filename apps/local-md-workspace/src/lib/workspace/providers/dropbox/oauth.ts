import { Effect, Predicate, Schedule } from "effect";
import type { OpendalWorkspaceIdentity } from "../identity.ts";
import { isRetryableHttpStatus, OAuthRequestError } from "../oauth-errors.ts";
import {
  createPkceChallenge,
  createPkceOAuthClient,
  createPkceVerifier,
  defaultPkceRedirectUri,
  oauthErrorMessage,
  parsePkceOAuthCallback,
  type PkceOAuthCallback,
} from "../pkce-oauth.ts";

export const DROPBOX_AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_CURRENT_ACCOUNT_URL = "https://api.dropboxapi.com/2/users/get_current_account";
export const DROPBOX_OAUTH_MESSAGE = "local-md-workspace:dropbox-oauth";
export const DROPBOX_REDIRECT_TRANSACTION_KEY = "local-md-workspace:dropbox-oauth-redirect";
export const DEFAULT_DROPBOX_SCOPES = [
  "files.metadata.read",
  "files.content.read",
  "files.content.write",
];

export type DropboxAccessToken = {
  accessToken: string;
  expiresAt: number;
  identity?: OpendalWorkspaceIdentity;
};

export type DropboxPkceOptions = {
  allowFullPageRedirect?: boolean;
  appKey: string;
  onBeforeFullPageRedirect?: (context: DropboxFullPageRedirectContext) => void;
  redirectUri?: string;
  scopes?: string[];
};

export type DropboxFullPageRedirectContext = {
  appKey: string;
  redirectUri: string;
  scopes: string[];
  state: string;
};

export type DropboxRedirectAccessToken = DropboxAccessToken & {
  appKey: string;
  redirectUri: string;
  scopes: string[];
  state: string;
};

export type DropboxOAuthCallback = PkceOAuthCallback;

const dropboxOAuth = createPkceOAuthClient<OpendalWorkspaceIdentity>({
  authorizeParams: { token_access_type: "online" },
  authorizeUrl: DROPBOX_AUTHORIZE_URL,
  clientIdField: "appKey",
  clientIdLabel: "app key",
  defaultScopes: DEFAULT_DROPBOX_SCOPES,
  displayName: "Dropbox",
  messageType: DROPBOX_OAUTH_MESSAGE,
  parseTokenIdentity: (record) => {
    let accountId = parseDropboxAccountId(record);
    return accountId ? { id: accountId, kind: "account" } : undefined;
  },
  popupName: "dropbox-oauth",
  redirectTransactionKey: DROPBOX_REDIRECT_TRANSACTION_KEY,
  tokenUrl: DROPBOX_TOKEN_URL,
});

export const defaultDropboxRedirectUri = defaultPkceRedirectUri;
export const parseDropboxOAuthCallback = parsePkceOAuthCallback;
export const createDropboxPkceVerifier = createPkceVerifier;
export const createDropboxPkceChallenge = createPkceChallenge;

export function hasDropboxOAuthCallback(search: string | URLSearchParams = window.location.search) {
  return dropboxOAuth.hasCallback(search);
}

export function hasDropboxRedirectTransaction(storage = window.sessionStorage) {
  return dropboxOAuth.hasRedirectTransaction(storage);
}

export function hasDropboxRedirectCallbackForStoredTransaction(
  search: string | URLSearchParams = window.location.search,
  storage = window.sessionStorage,
) {
  return dropboxOAuth.hasRedirectCallbackForStoredTransaction(search, storage);
}

export function completeDropboxPopupOAuthIfPresent() {
  return dropboxOAuth.completePopupIfPresent();
}

export const authorizeDropboxWithPkce = Effect.fn("authorizeDropboxWithPkce")(function* (
  options: DropboxPkceOptions,
) {
  let onBeforeFullPageRedirect = options.onBeforeFullPageRedirect;
  let token: DropboxAccessToken = yield* dropboxOAuth.authorize({
    allowFullPageRedirect: options.allowFullPageRedirect,
    clientId: options.appKey,
    onBeforeFullPageRedirect: onBeforeFullPageRedirect
      ? ({ clientId, ...context }) => onBeforeFullPageRedirect({ appKey: clientId, ...context })
      : undefined,
    redirectUri: options.redirectUri,
    scopes: options.scopes,
  });
  return token;
});

export const completeDropboxRedirectOAuthIfPresent = Effect.fn(
  "completeDropboxRedirectOAuthIfPresent",
)(function* (
  options: {
    search?: string | URLSearchParams;
    storage?: Storage;
  } = {},
) {
  let token = yield* dropboxOAuth.completeRedirectIfPresent(options);
  if (!token) return null;
  let { clientId, ...rest } = token;
  return { ...rest, appKey: clientId } satisfies DropboxRedirectAccessToken;
});

export function createDropboxAuthorizeUrl(options: {
  appKey: string;
  codeChallenge: string;
  redirectUri: string;
  scopes?: string[];
  state: string;
}) {
  let { appKey, ...rest } = options;
  return dropboxOAuth.createAuthorizeUrl({ ...rest, clientId: appKey });
}

/** Retry policy for the idempotent account lookup: 3 jittered retries from 300ms. */
export const dropboxAccountIdentityRetrySchedule = Schedule.max([
  Schedule.exponential("300 millis").pipe(Schedule.jittered),
  Schedule.recurs(3),
]);

const requestAccountIdentity = Effect.fn("requestDropboxAccountIdentity")(function* (
  accessToken: string,
) {
  let { payload, response } = yield* Effect.tryPromise({
    catch: (cause) =>
      new OAuthRequestError({
        cause,
        message: Predicate.isError(cause) ? cause.message : String(cause),
        provider: "Dropbox",
        request: "account-identity",
        retryable: true,
      }),
    try: async (signal) => {
      let response = await fetch(DROPBOX_CURRENT_ACCOUNT_URL, {
        body: "null",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal,
      });
      let payload: unknown = await response.json().catch(() => null);
      return { payload, response };
    },
  });
  if (!response.ok) {
    return yield* new OAuthRequestError({
      message:
        oauthErrorMessage(payload) ??
        `Dropbox account identity request failed (${response.status}).`,
      provider: "Dropbox",
      request: "account-identity",
      retryable: isRetryableHttpStatus(response.status),
      status: response.status,
    });
  }

  let accountId = parseDropboxAccountId(payload);
  if (!accountId) {
    return yield* new OAuthRequestError({
      message: "Dropbox account identity response was invalid.",
      provider: "Dropbox",
      request: "account-identity",
      retryable: false,
      status: response.status,
    });
  }
  return { id: accountId, kind: "account" } satisfies OpendalWorkspaceIdentity;
});

/**
 * Looks up the Dropbox account for an access token, retrying network failures,
 * 429, and 5xx responses with {@link dropboxAccountIdentityRetrySchedule}.
 */
export const fetchDropboxAccountIdentity = (
  accessToken: string,
  retrySchedule: Schedule.Schedule<unknown, unknown> = dropboxAccountIdentityRetrySchedule,
) =>
  requestAccountIdentity(accessToken).pipe(
    Effect.retry(
      retrySchedule.pipe(
        Schedule.setInputType<OAuthRequestError>(),
        Schedule.while(({ input }) => input.retryable),
      ),
    ),
  );

function parseDropboxAccountId(value: unknown) {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  return typeof record.account_id == "string" && record.account_id.trim()
    ? record.account_id.trim()
    : null;
}
