import type { OpendalWorkspaceIdentity } from "./opendal-workspace-identity.ts";

export const GOOGLE_DRIVE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_DRIVE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_ABOUT_URL = "https://www.googleapis.com/drive/v3/about";
const GOOGLE_IDENTITY_SERVICES_URL = "https://accounts.google.com/gsi/client";
export const GOOGLE_DRIVE_OAUTH_MESSAGE = "local-md-workspace:google-drive-oauth";
export const GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY =
  "local-md-workspace:google-drive-oauth-redirect";
export const DEFAULT_GOOGLE_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"];

let googleDriveIdentityServicesPromise: Promise<void> | null = null;

export type GoogleDriveAccessToken = {
  accessToken: string;
  expiresAt: number;
};

export type GoogleDrivePkceOptions = {
  clientId: string;
  redirectUri?: string;
  scopes?: string[];
};

export type GoogleDriveRedirectAccessToken = GoogleDriveAccessToken & {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
};

type GoogleDriveOAuthMessage = {
  code?: string;
  error?: string;
  errorDescription?: string;
  state: string;
  type: typeof GOOGLE_DRIVE_OAUTH_MESSAGE;
};

export type GoogleDriveOAuthCallback = Omit<GoogleDriveOAuthMessage, "type">;

type GoogleDriveRedirectTransaction = {
  clientId: string;
  codeVerifier: string;
  createdAt: number;
  redirectUri: string;
  scopes: string[];
  state: string;
};

type GoogleDriveIdentityServicesWindow = Window & {
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient(config: GoogleDriveTokenClientConfig): GoogleDriveTokenClient;
      };
    };
  };
};

type GoogleDriveTokenClientConfig = {
  callback: (response: GoogleDriveTokenResponse) => void;
  client_id: string;
  error_callback?: (error: GoogleDriveTokenError) => void;
  include_granted_scopes?: boolean;
  scope: string;
};

type GoogleDriveTokenClient = {
  requestAccessToken(options?: { prompt?: string }): void;
};

type GoogleDriveTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
  expires_in?: number | string;
  scope?: string;
};

type GoogleDriveTokenError = {
  error?: string;
  error_description?: string;
  message?: string;
  type?: string;
};

export function defaultGoogleDriveRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

export function hasGoogleDriveOAuthCallback(
  search: string | URLSearchParams = window.location.search,
) {
  return Boolean(parseGoogleDriveOAuthCallback(search));
}

export function hasGoogleDriveRedirectTransaction(storage = window.sessionStorage) {
  try {
    return Boolean(storage.getItem(GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY));
  } catch {
    return false;
  }
}

export function hasGoogleDriveRedirectCallbackForStoredTransaction(
  search: string | URLSearchParams = window.location.search,
  storage = window.sessionStorage,
) {
  let callback = parseGoogleDriveOAuthCallback(search);
  if (!callback) return false;

  try {
    let raw = storage.getItem(GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY);
    if (!raw) return false;
    let transaction = parseGoogleDriveRedirectTransaction(JSON.parse(raw));
    return transaction?.state == callback.state;
  } catch {
    return false;
  }
}

export function completeGoogleDrivePopupOAuthIfPresent() {
  let callback = parseGoogleDriveOAuthCallback(window.location.search);
  if (!callback || !window.opener) return false;

  let message: GoogleDriveOAuthMessage = {
    ...callback,
    type: GOOGLE_DRIVE_OAUTH_MESSAGE,
  };

  window.opener.postMessage(message, window.location.origin);
  window.close();
  return true;
}

export function preloadGoogleDriveIdentityServices() {
  void loadGoogleDriveIdentityServices().catch(() => {});
}

export async function authorizeGoogleDriveWithPkce(options: GoogleDrivePkceOptions) {
  let clientId = requireGoogleDriveClientId(options.clientId);
  let scopes = options.scopes ?? DEFAULT_GOOGLE_DRIVE_SCOPES;

  await loadGoogleDriveIdentityServices();
  return requestGoogleDriveAccessToken({ clientId, scopes });
}

export async function completeGoogleDriveRedirectOAuthIfPresent(
  options: {
    search?: string | URLSearchParams;
    storage?: Storage;
  } = {},
): Promise<GoogleDriveRedirectAccessToken | null> {
  let callback = parseGoogleDriveOAuthCallback(options.search ?? window.location.search);
  if (!callback) return null;

  let transaction = takeGoogleDriveRedirectTransaction(options.storage);
  clearGoogleDriveOAuthCallbackFromUrl();

  if (!transaction) throw new Error("Google Drive authorization state was not found.");
  if (callback.state != transaction.state) {
    throw new Error("Google Drive authorization state did not match.");
  }
  if (callback.error) {
    throw new Error(googleDriveOAuthCallbackError(callback.error, callback.errorDescription));
  }
  if (!callback.code) throw new Error("Google Drive authorization did not return a code.");

  let token = await exchangeGoogleDriveCodeForToken({
    clientId: transaction.clientId,
    code: callback.code,
    codeVerifier: transaction.codeVerifier,
    redirectUri: transaction.redirectUri,
  });

  return {
    ...token,
    clientId: transaction.clientId,
    redirectUri: transaction.redirectUri,
    scopes: transaction.scopes,
    state: transaction.state,
  };
}

export async function fetchGoogleDriveAccountIdentity(
  accessToken: string,
): Promise<OpendalWorkspaceIdentity> {
  let url = new URL(GOOGLE_DRIVE_ABOUT_URL);
  url.searchParams.set("fields", "user(permissionId)");
  let response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  let payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      googleDriveTokenError(payload) ??
        `Google Drive account identity request failed (${response.status}).`,
    );
  }

  let permissionId = parseGoogleDrivePermissionId(payload);
  if (!permissionId) throw new Error("Google Drive account identity response was invalid.");
  return { id: permissionId, kind: "account" };
}

export function parseGoogleDriveOAuthCallback(
  search: string | URLSearchParams,
): GoogleDriveOAuthCallback | null {
  let params = typeof search == "string" ? new URLSearchParams(search) : search;
  let state = params.get("state");
  let code = params.get("code");
  let error = params.get("error");

  if (!state || (!code && !error)) return null;

  return {
    code: code ?? undefined,
    error: error ?? undefined,
    errorDescription: params.get("error_description") ?? undefined,
    state,
  };
}

export function createGoogleDriveAuthorizeUrl(options: {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes?: string[];
  state: string;
}) {
  let url = new URL(GOOGLE_DRIVE_AUTHORIZE_URL);
  url.searchParams.set("client_id", requireGoogleDriveClientId(options.clientId));
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (options.scopes ?? DEFAULT_GOOGLE_DRIVE_SCOPES).join(" "));
  url.searchParams.set("state", options.state);
  return url;
}

export function createGoogleDrivePkceVerifier(bytes: Uint8Array) {
  return base64Url(bytes);
}

export async function createGoogleDrivePkceChallenge(verifier: string) {
  let data = new TextEncoder().encode(verifier);
  let digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(digest));
}

async function loadGoogleDriveIdentityServices() {
  if (googleDriveTokenClientFactory()) return;
  if (typeof document == "undefined") {
    throw new Error("Google Drive Identity Services is not available.");
  }
  if (googleDriveIdentityServicesPromise) return googleDriveIdentityServicesPromise;

  googleDriveIdentityServicesPromise = new Promise<void>((resolve, reject) => {
    let existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_IDENTITY_SERVICES_URL}"]`,
    );
    let script = existing ?? document.createElement("script");

    let cleanup = () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
    let handleLoad = () => {
      cleanup();
      if (googleDriveTokenClientFactory()) {
        resolve();
      } else {
        reject(new Error("Google Drive Identity Services did not initialize."));
      }
    };
    let handleError = () => {
      cleanup();
      googleDriveIdentityServicesPromise = null;
      reject(new Error("Google Drive Identity Services failed to load."));
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!existing) {
      script.async = true;
      script.defer = true;
      script.src = GOOGLE_IDENTITY_SERVICES_URL;
      document.head.append(script);
    }
  });

  return googleDriveIdentityServicesPromise;
}

function requestGoogleDriveAccessToken(options: { clientId: string; scopes: string[] }) {
  let initTokenClient = googleDriveTokenClientFactory();
  if (!initTokenClient) throw new Error("Google Drive Identity Services is not available.");

  return new Promise<GoogleDriveAccessToken>((resolve, reject) => {
    let client = initTokenClient({
      callback: (response) => {
        if (response.error) {
          reject(new Error(googleDriveTokenRequestError(response)));
          return;
        }

        let token = parseGoogleDriveTokenResponse(response);
        if (!token) {
          reject(new Error("Google Drive token request returned an invalid response."));
          return;
        }

        resolve({
          accessToken: token.accessToken,
          expiresAt: Date.now() + token.expiresIn * 1000,
        });
      },
      client_id: options.clientId,
      error_callback: (error) => reject(new Error(googleDriveTokenRequestError(error))),
      include_granted_scopes: true,
      scope: options.scopes.join(" "),
    });

    client.requestAccessToken();
  });
}

function googleDriveTokenClientFactory() {
  let oauth2 = (window as GoogleDriveIdentityServicesWindow).google?.accounts?.oauth2;
  if (!oauth2?.initTokenClient) return undefined;
  return (config: GoogleDriveTokenClientConfig) => oauth2.initTokenClient(config);
}

async function exchangeGoogleDriveCodeForToken(options: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<GoogleDriveAccessToken> {
  let body = new URLSearchParams();
  body.set("client_id", options.clientId);
  body.set("code", options.code);
  body.set("code_verifier", options.codeVerifier);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", options.redirectUri);

  let response = await fetch(GOOGLE_DRIVE_TOKEN_URL, {
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  let payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      googleDriveTokenError(payload) ?? `Google Drive token exchange failed (${response.status}).`,
    );
  }

  let tokenResponse = parseGoogleDriveTokenResponse(payload);
  if (!tokenResponse) {
    throw new Error("Google Drive token exchange returned an invalid response.");
  }

  return {
    accessToken: tokenResponse.accessToken,
    expiresAt: Date.now() + tokenResponse.expiresIn * 1000,
  };
}

function requireGoogleDriveClientId(value: string) {
  let clientId = value.trim();
  if (!clientId) throw new Error("Google Drive client ID is required.");
  return clientId;
}

function parseGoogleDriveTokenResponse(value: unknown) {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  let expiresIn =
    typeof record.expires_in == "number"
      ? record.expires_in
      : typeof record.expires_in == "string"
        ? Number(record.expires_in)
        : NaN;

  if (typeof record.access_token != "string" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null;
  }

  return {
    accessToken: record.access_token,
    expiresIn,
  };
}

function googleDriveTokenRequestError(value: GoogleDriveTokenError | GoogleDriveTokenResponse) {
  let record = value as GoogleDriveTokenError & GoogleDriveTokenResponse;
  if (record.error == "access_denied") {
    return "Google Drive authorization was denied or blocked by Google OAuth app settings. If this is a development app, add your Google account as a test user and check the Drive scope before reconnecting.";
  }
  if (record.type == "popup_failed_to_open") {
    return "Google Drive authorization popup was blocked. Allow popups for this site and try again.";
  }
  if (record.type == "popup_closed") {
    return "Google Drive authorization was closed before it completed. Reconnect Google Drive workspace to continue.";
  }

  let reason = record.error_description ?? record.message ?? record.error ?? record.type;
  return reason
    ? `Google Drive token request failed: ${reason}`
    : "Google Drive token request failed.";
}

function googleDriveTokenError(value: unknown) {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  if (typeof record.error_description == "string") {
    return `Google Drive token exchange failed: ${record.error_description}`;
  }
  if (typeof record.error == "string") return `Google Drive token exchange failed: ${record.error}`;
  return null;
}

function parseGoogleDrivePermissionId(value: unknown) {
  if (!value || typeof value != "object") return null;
  let user = (value as Record<string, unknown>).user;
  if (!user || typeof user != "object") return null;
  let permissionId = (user as Record<string, unknown>).permissionId;
  return typeof permissionId == "string" && permissionId.trim() ? permissionId.trim() : null;
}

function googleDriveOAuthCallbackError(error: string, description: string | undefined) {
  if (error == "access_denied") {
    return "Google Drive authorization was denied or blocked by Google OAuth app settings. If this is a development app, add your Google account as a test user and check the Drive scope before reconnecting.";
  }
  return description
    ? `Google Drive authorization failed: ${description}`
    : `Google Drive authorization failed: ${error}`;
}

function takeGoogleDriveRedirectTransaction(storage = window.sessionStorage) {
  try {
    let raw = storage.getItem(GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY);
    storage.removeItem(GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY);
    if (!raw) return null;
    return parseGoogleDriveRedirectTransaction(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseGoogleDriveRedirectTransaction(
  value: unknown,
): GoogleDriveRedirectTransaction | null {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  if (
    typeof record.clientId != "string" ||
    typeof record.codeVerifier != "string" ||
    typeof record.createdAt != "number" ||
    typeof record.redirectUri != "string" ||
    typeof record.state != "string" ||
    !Array.isArray(record.scopes)
  ) {
    return null;
  }

  let scopes = record.scopes.filter((scope): scope is string => typeof scope == "string");
  if (!record.clientId.trim() || !record.codeVerifier || !record.redirectUri || !record.state) {
    return null;
  }

  return {
    clientId: record.clientId.trim(),
    codeVerifier: record.codeVerifier,
    createdAt: record.createdAt,
    redirectUri: record.redirectUri,
    scopes,
    state: record.state,
  };
}

function clearGoogleDriveOAuthCallbackFromUrl() {
  if (typeof window == "undefined" || !window.history?.replaceState) return;

  let url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  url.searchParams.delete("state");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function base64Url(bytes: Uint8Array) {
  let binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
