export const GOOGLE_DRIVE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_DRIVE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_DRIVE_OAUTH_MESSAGE = "local-md-workspace:google-drive-oauth";
export const GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY =
  "local-md-workspace:google-drive-oauth-redirect";
export const DEFAULT_GOOGLE_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const GOOGLE_DRIVE_POPUP_CLOSED_POLL_MS = 500;

export type GoogleDriveAccessToken = {
  accessToken: string;
  expiresAt: number;
};

export type GoogleDrivePkceOptions = {
  allowFullPageRedirect?: boolean;
  clientId: string;
  onBeforeFullPageRedirect?: (context: GoogleDriveFullPageRedirectContext) => void;
  redirectUri?: string;
  scopes?: string[];
};

export type GoogleDriveFullPageRedirectContext = {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
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

export async function authorizeGoogleDriveWithPkce(options: GoogleDrivePkceOptions) {
  let clientId = requireGoogleDriveClientId(options.clientId);
  let redirectUri = options.redirectUri ?? defaultGoogleDriveRedirectUri();
  let scopes = options.scopes ?? DEFAULT_GOOGLE_DRIVE_SCOPES;
  let popup = openGoogleDrivePopup();
  if (!popup) {
    if (options.allowFullPageRedirect) {
      return startGoogleDrivePkceRedirect({
        clientId,
        onBeforeRedirect: options.onBeforeFullPageRedirect,
        redirectUri,
        scopes,
      });
    }
    throw new Error("Google Drive authorization popup was blocked.");
  }

  try {
    let codeVerifier = randomGoogleDrivePkceVerifier();
    let state = randomGoogleDrivePkceVerifier();
    let codeChallenge = await createGoogleDrivePkceChallenge(codeVerifier);
    let authUrl = createGoogleDriveAuthorizeUrl({
      clientId,
      codeChallenge,
      redirectUri,
      scopes,
      state,
    });

    let code = await waitForGoogleDrivePopupCode(popup, authUrl, state);
    return exchangeGoogleDriveCodeForToken({
      clientId,
      code,
      codeVerifier,
      redirectUri,
    });
  } catch (error) {
    closeGoogleDrivePopup(popup);
    throw error;
  }
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

function openGoogleDrivePopup() {
  let popup = window.open("about:blank", "google-drive-oauth", "popup,width=520,height=720");
  if (!popup) return null;
  popup.document.title = "Google Drive authorization";
  popup.focus();
  return popup;
}

async function startGoogleDrivePkceRedirect(options: {
  clientId: string;
  onBeforeRedirect?: (context: GoogleDriveFullPageRedirectContext) => void;
  redirectUri: string;
  scopes: string[];
}): Promise<never> {
  let codeVerifier = randomGoogleDrivePkceVerifier();
  let state = randomGoogleDrivePkceVerifier();
  let codeChallenge = await createGoogleDrivePkceChallenge(codeVerifier);
  let authUrl = createGoogleDriveAuthorizeUrl({
    clientId: options.clientId,
    codeChallenge,
    redirectUri: options.redirectUri,
    scopes: options.scopes,
    state,
  });

  options.onBeforeRedirect?.({
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    scopes: options.scopes,
    state,
  });
  saveGoogleDriveRedirectTransaction({
    clientId: options.clientId,
    codeVerifier,
    createdAt: Date.now(),
    redirectUri: options.redirectUri,
    scopes: options.scopes,
    state,
  });

  window.location.assign(authUrl.href);
  return new Promise<never>(() => {});
}

function waitForGoogleDrivePopupCode(popup: Window, authUrl: URL, expectedState: string) {
  return new Promise<string>((resolve, reject) => {
    let closedPoll = 0;
    let timeout = 0;
    let cleanup = () => {
      window.removeEventListener("message", handleMessage);
      window.clearInterval(closedPoll);
      window.clearTimeout(timeout);
    };

    let handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin != window.location.origin || !isGoogleDriveOAuthMessage(event.data)) return;
      if (event.data.state != expectedState) return;

      cleanup();
      closeGoogleDrivePopup(popup);

      if (event.data.error) {
        reject(
          new Error(googleDriveOAuthCallbackError(event.data.error, event.data.errorDescription)),
        );
      } else if (event.data.code) {
        resolve(event.data.code);
      } else {
        reject(new Error("Google Drive authorization did not return a code."));
      }
    };

    timeout = window.setTimeout(
      () => {
        cleanup();
        closeGoogleDrivePopup(popup);
        reject(
          new Error(
            "Google Drive authorization timed out. Reconnect Google Drive workspace to continue.",
          ),
        );
      },
      5 * 60 * 1000,
    );

    closedPoll = window.setInterval(() => {
      if (!googleDrivePopupClosed(popup)) return;

      cleanup();
      reject(
        new Error(
          "Google Drive authorization was closed before it completed. Reconnect Google Drive workspace to continue.",
        ),
      );
    }, GOOGLE_DRIVE_POPUP_CLOSED_POLL_MS);

    window.addEventListener("message", handleMessage);
    popup.location.href = authUrl.href;
  });
}

function closeGoogleDrivePopup(popup: Window) {
  try {
    popup.close();
  } catch {}
}

function googleDrivePopupClosed(popup: Window) {
  try {
    return popup.closed;
  } catch {
    return true;
  }
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

function isGoogleDriveOAuthMessage(value: unknown): value is GoogleDriveOAuthMessage {
  if (!value || typeof value != "object") return false;
  let record = value as Record<string, unknown>;
  return record.type == GOOGLE_DRIVE_OAUTH_MESSAGE && typeof record.state == "string";
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

function googleDriveTokenError(value: unknown) {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  if (typeof record.error_description == "string") {
    return `Google Drive token exchange failed: ${record.error_description}`;
  }
  if (typeof record.error == "string") return `Google Drive token exchange failed: ${record.error}`;
  return null;
}

function googleDriveOAuthCallbackError(error: string, description: string | undefined) {
  if (error == "access_denied") {
    return "Google Drive authorization was denied or blocked by Google OAuth app settings. If this is a development app, add your Google account as a test user and check the Drive scope before reconnecting.";
  }
  return description
    ? `Google Drive authorization failed: ${description}`
    : `Google Drive authorization failed: ${error}`;
}

function saveGoogleDriveRedirectTransaction(transaction: GoogleDriveRedirectTransaction) {
  try {
    window.sessionStorage.setItem(
      GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY,
      JSON.stringify(transaction),
    );
  } catch {}
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

function randomGoogleDrivePkceVerifier() {
  let bytes = new Uint8Array(64);
  globalThis.crypto.getRandomValues(bytes);
  return createGoogleDrivePkceVerifier(bytes);
}

function base64Url(bytes: Uint8Array) {
  let binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
