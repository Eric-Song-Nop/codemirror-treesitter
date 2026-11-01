import type { OpendalWorkspaceIdentity } from "../identity.ts";
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

export function authorizeDropboxWithPkce(options: DropboxPkceOptions): Promise<DropboxAccessToken> {
  let onBeforeFullPageRedirect = options.onBeforeFullPageRedirect;
  return dropboxOAuth.authorize({
    allowFullPageRedirect: options.allowFullPageRedirect,
    clientId: options.appKey,
    onBeforeFullPageRedirect: onBeforeFullPageRedirect
      ? ({ clientId, ...context }) => onBeforeFullPageRedirect({ appKey: clientId, ...context })
      : undefined,
    redirectUri: options.redirectUri,
    scopes: options.scopes,
  });
}

export async function completeDropboxRedirectOAuthIfPresent(
  options: {
    search?: string | URLSearchParams;
    storage?: Storage;
  } = {},
): Promise<DropboxRedirectAccessToken | null> {
  let token = await dropboxOAuth.completeRedirectIfPresent(options);
  if (!token) return null;
  let { clientId, ...rest } = token;
  return { ...rest, appKey: clientId };
}

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

export async function fetchDropboxAccountIdentity(
  accessToken: string,
): Promise<OpendalWorkspaceIdentity> {
  let response = await fetch(DROPBOX_CURRENT_ACCOUNT_URL, {
    body: "null",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  let payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      oauthErrorMessage(payload) ?? `Dropbox account identity request failed (${response.status}).`,
    );
  }

  let accountId = parseDropboxAccountId(payload);
  if (!accountId) throw new Error("Dropbox account identity response was invalid.");
  return { id: accountId, kind: "account" };
}

function parseDropboxAccountId(value: unknown) {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  return typeof record.account_id == "string" && record.account_id.trim()
    ? record.account_id.trim()
    : null;
}
