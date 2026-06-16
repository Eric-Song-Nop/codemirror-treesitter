export const ONEDRIVE_AUTHORIZE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const ONEDRIVE_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const ONEDRIVE_OAUTH_MESSAGE = "local-md-workspace:onedrive-oauth";
export const ONEDRIVE_REDIRECT_TRANSACTION_KEY = "local-md-workspace:onedrive-oauth-redirect";
export const DEFAULT_ONEDRIVE_SCOPES = ["Files.ReadWrite"];

export type OneDriveAccessToken = {
  accessToken: string;
  expiresAt: number;
};

export type OneDrivePkceOptions = {
  allowFullPageRedirect?: boolean;
  clientId: string;
  onBeforeFullPageRedirect?: (context: OneDriveFullPageRedirectContext) => void;
  redirectUri?: string;
  scopes?: string[];
};

export type OneDriveFullPageRedirectContext = {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
};

export type OneDriveRedirectAccessToken = OneDriveAccessToken & {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
};

type OneDriveOAuthMessage = {
  code?: string;
  error?: string;
  errorDescription?: string;
  state: string;
  type: typeof ONEDRIVE_OAUTH_MESSAGE;
};

export type OneDriveOAuthCallback = Omit<OneDriveOAuthMessage, "type">;

type OneDriveRedirectTransaction = {
  clientId: string;
  codeVerifier: string;
  createdAt: number;
  redirectUri: string;
  scopes: string[];
  state: string;
};

export function defaultOneDriveRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

export function hasOneDriveOAuthCallback(
  search: string | URLSearchParams = window.location.search,
) {
  return Boolean(parseOneDriveOAuthCallback(search));
}

export function hasOneDriveRedirectTransaction(storage = window.sessionStorage) {
  try {
    return Boolean(storage.getItem(ONEDRIVE_REDIRECT_TRANSACTION_KEY));
  } catch {
    return false;
  }
}

export function hasOneDriveRedirectCallbackForStoredTransaction(
  search: string | URLSearchParams = window.location.search,
  storage = window.sessionStorage,
) {
  let callback = parseOneDriveOAuthCallback(search);
  if (!callback) return false;

  try {
    let raw = storage.getItem(ONEDRIVE_REDIRECT_TRANSACTION_KEY);
    if (!raw) return false;
    let transaction = parseOneDriveRedirectTransaction(JSON.parse(raw));
    return transaction?.state == callback.state;
  } catch {
    return false;
  }
}

export function completeOneDrivePopupOAuthIfPresent() {
  let callback = parseOneDriveOAuthCallback(window.location.search);
  if (!callback || !window.opener) return false;

  let message: OneDriveOAuthMessage = {
    ...callback,
    type: ONEDRIVE_OAUTH_MESSAGE,
  };

  window.opener.postMessage(message, window.location.origin);
  window.close();
  return true;
}

export async function authorizeOneDriveWithPkce(options: OneDrivePkceOptions) {
  let clientId = requireOneDriveClientId(options.clientId);
  let redirectUri = options.redirectUri ?? defaultOneDriveRedirectUri();
  let scopes = options.scopes ?? DEFAULT_ONEDRIVE_SCOPES;
  let popup = openOneDrivePopup();
  if (!popup) {
    if (options.allowFullPageRedirect) {
      return startOneDrivePkceRedirect({
        clientId,
        onBeforeRedirect: options.onBeforeFullPageRedirect,
        redirectUri,
        scopes,
      });
    }
    throw new Error("OneDrive authorization popup was blocked.");
  }

  try {
    let codeVerifier = randomOneDrivePkceVerifier();
    let state = randomOneDrivePkceVerifier();
    let codeChallenge = await createOneDrivePkceChallenge(codeVerifier);
    let authUrl = createOneDriveAuthorizeUrl({
      clientId,
      codeChallenge,
      redirectUri,
      scopes,
      state,
    });

    let code = await waitForOneDrivePopupCode(popup, authUrl, state);
    return exchangeOneDriveCodeForToken({
      clientId,
      code,
      codeVerifier,
      redirectUri,
      scopes,
    });
  } catch (error) {
    closeOneDrivePopup(popup);
    throw error;
  }
}

export async function completeOneDriveRedirectOAuthIfPresent(
  options: {
    search?: string | URLSearchParams;
    storage?: Storage;
  } = {},
): Promise<OneDriveRedirectAccessToken | null> {
  let callback = parseOneDriveOAuthCallback(options.search ?? window.location.search);
  if (!callback) return null;

  let transaction = takeOneDriveRedirectTransaction(options.storage);
  clearOneDriveOAuthCallbackFromUrl();

  if (!transaction) throw new Error("OneDrive authorization state was not found.");
  if (callback.state != transaction.state) {
    throw new Error("OneDrive authorization state did not match.");
  }
  if (callback.error) {
    throw new Error(oneDriveOAuthCallbackError(callback.error, callback.errorDescription));
  }
  if (!callback.code) throw new Error("OneDrive authorization did not return a code.");

  let token = await exchangeOneDriveCodeForToken({
    clientId: transaction.clientId,
    code: callback.code,
    codeVerifier: transaction.codeVerifier,
    redirectUri: transaction.redirectUri,
    scopes: transaction.scopes,
  });

  return {
    ...token,
    clientId: transaction.clientId,
    redirectUri: transaction.redirectUri,
    scopes: transaction.scopes,
    state: transaction.state,
  };
}

export function parseOneDriveOAuthCallback(
  search: string | URLSearchParams,
): OneDriveOAuthCallback | null {
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

export function createOneDriveAuthorizeUrl(options: {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes?: string[];
  state: string;
}) {
  let url = new URL(ONEDRIVE_AUTHORIZE_URL);
  url.searchParams.set("client_id", requireOneDriveClientId(options.clientId));
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (options.scopes ?? DEFAULT_ONEDRIVE_SCOPES).join(" "));
  url.searchParams.set("state", options.state);
  return url;
}

export function createOneDrivePkceVerifier(bytes: Uint8Array) {
  return base64Url(bytes);
}

export async function createOneDrivePkceChallenge(verifier: string) {
  let data = new TextEncoder().encode(verifier);
  let digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(digest));
}

function openOneDrivePopup() {
  let popup = window.open("about:blank", "onedrive-oauth", "popup,width=520,height=720");
  if (!popup) return null;
  popup.document.title = "OneDrive authorization";
  popup.focus();
  return popup;
}

async function startOneDrivePkceRedirect(options: {
  clientId: string;
  onBeforeRedirect?: (context: OneDriveFullPageRedirectContext) => void;
  redirectUri: string;
  scopes: string[];
}): Promise<never> {
  let codeVerifier = randomOneDrivePkceVerifier();
  let state = randomOneDrivePkceVerifier();
  let codeChallenge = await createOneDrivePkceChallenge(codeVerifier);
  let authUrl = createOneDriveAuthorizeUrl({
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
  saveOneDriveRedirectTransaction({
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

function waitForOneDrivePopupCode(popup: Window, authUrl: URL, expectedState: string) {
  return new Promise<string>((resolve, reject) => {
    let cleanup = () => {
      window.removeEventListener("message", handleMessage);
      window.clearTimeout(timeout);
    };

    let handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin != window.location.origin || !isOneDriveOAuthMessage(event.data)) return;
      if (event.data.state != expectedState) return;

      cleanup();
      closeOneDrivePopup(popup);

      if (event.data.error) {
        reject(
          new Error(oneDriveOAuthCallbackError(event.data.error, event.data.errorDescription)),
        );
      } else if (event.data.code) {
        resolve(event.data.code);
      } else {
        reject(new Error("OneDrive authorization did not return a code."));
      }
    };

    let timeout = window.setTimeout(
      () => {
        cleanup();
        closeOneDrivePopup(popup);
        reject(
          new Error("OneDrive authorization timed out. Reconnect OneDrive workspace to continue."),
        );
      },
      5 * 60 * 1000,
    );

    window.addEventListener("message", handleMessage);
    popup.location.href = authUrl.href;
  });
}

function closeOneDrivePopup(popup: Window) {
  try {
    popup.close();
  } catch {}
}

async function exchangeOneDriveCodeForToken(options: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
}): Promise<OneDriveAccessToken> {
  let body = new URLSearchParams();
  body.set("client_id", options.clientId);
  body.set("code", options.code);
  body.set("code_verifier", options.codeVerifier);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", options.redirectUri);
  body.set("scope", options.scopes.join(" "));

  let response = await fetch(ONEDRIVE_TOKEN_URL, {
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  let payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      oneDriveTokenError(payload) ?? `OneDrive token exchange failed (${response.status}).`,
    );
  }

  let tokenResponse = parseOneDriveTokenResponse(payload);
  if (!tokenResponse) {
    throw new Error("OneDrive token exchange returned an invalid response.");
  }

  return {
    accessToken: tokenResponse.accessToken,
    expiresAt: Date.now() + tokenResponse.expiresIn * 1000,
  };
}

function requireOneDriveClientId(value: string) {
  let clientId = value.trim();
  if (!clientId) throw new Error("OneDrive client ID is required.");
  return clientId;
}

function isOneDriveOAuthMessage(value: unknown): value is OneDriveOAuthMessage {
  if (!value || typeof value != "object") return false;
  let record = value as Record<string, unknown>;
  return record.type == ONEDRIVE_OAUTH_MESSAGE && typeof record.state == "string";
}

function parseOneDriveTokenResponse(value: unknown) {
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

function oneDriveTokenError(value: unknown) {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  if (typeof record.error_description == "string") {
    return `OneDrive token exchange failed: ${record.error_description}`;
  }
  if (typeof record.error == "string") return `OneDrive token exchange failed: ${record.error}`;
  return null;
}

function oneDriveOAuthCallbackError(error: string, description: string | undefined) {
  if (error == "access_denied") return "OneDrive authorization was denied.";
  return description
    ? `OneDrive authorization failed: ${description}`
    : `OneDrive authorization failed: ${error}`;
}

function saveOneDriveRedirectTransaction(transaction: OneDriveRedirectTransaction) {
  try {
    window.sessionStorage.setItem(ONEDRIVE_REDIRECT_TRANSACTION_KEY, JSON.stringify(transaction));
  } catch {}
}

function takeOneDriveRedirectTransaction(storage = window.sessionStorage) {
  try {
    let raw = storage.getItem(ONEDRIVE_REDIRECT_TRANSACTION_KEY);
    storage.removeItem(ONEDRIVE_REDIRECT_TRANSACTION_KEY);
    if (!raw) return null;
    return parseOneDriveRedirectTransaction(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseOneDriveRedirectTransaction(value: unknown): OneDriveRedirectTransaction | null {
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

function clearOneDriveOAuthCallbackFromUrl() {
  if (typeof window == "undefined" || !window.history?.replaceState) return;

  let url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  url.searchParams.delete("state");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function randomOneDrivePkceVerifier() {
  let bytes = new Uint8Array(64);
  globalThis.crypto.getRandomValues(bytes);
  return createOneDrivePkceVerifier(bytes);
}

function base64Url(bytes: Uint8Array) {
  let binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
