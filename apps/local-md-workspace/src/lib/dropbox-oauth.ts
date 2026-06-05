export const DROPBOX_AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
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

type DropboxOAuthMessage = {
  code?: string;
  error?: string;
  errorDescription?: string;
  state: string;
  type: typeof DROPBOX_OAUTH_MESSAGE;
};

export type DropboxOAuthCallback = Omit<DropboxOAuthMessage, "type">;

type DropboxRedirectTransaction = {
  appKey: string;
  codeVerifier: string;
  createdAt: number;
  redirectUri: string;
  scopes: string[];
  state: string;
};

export function defaultDropboxRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

export function hasDropboxOAuthCallback(search: string | URLSearchParams = window.location.search) {
  return Boolean(parseDropboxOAuthCallback(search));
}

export function completeDropboxPopupOAuthIfPresent() {
  let callback = parseDropboxOAuthCallback(window.location.search);
  if (!callback || !window.opener) return false;

  let message: DropboxOAuthMessage = {
    ...callback,
    type: DROPBOX_OAUTH_MESSAGE,
  };

  window.opener.postMessage(message, window.location.origin);
  window.close();
  return true;
}

export async function authorizeDropboxWithPkce(options: DropboxPkceOptions) {
  let appKey = requireDropboxAppKey(options.appKey);
  let redirectUri = options.redirectUri ?? defaultDropboxRedirectUri();
  let scopes = options.scopes ?? DEFAULT_DROPBOX_SCOPES;
  let popup = openDropboxPopup();
  if (!popup) {
    if (options.allowFullPageRedirect) {
      return startDropboxPkceRedirect({
        appKey,
        onBeforeRedirect: options.onBeforeFullPageRedirect,
        redirectUri,
        scopes,
      });
    }
    throw new Error("Dropbox authorization popup was blocked.");
  }

  try {
    let codeVerifier = randomDropboxPkceVerifier();
    let state = randomDropboxPkceVerifier();
    let codeChallenge = await createDropboxPkceChallenge(codeVerifier);
    let authUrl = createDropboxAuthorizeUrl({
      appKey,
      codeChallenge,
      redirectUri,
      scopes,
      state,
    });

    let code = await waitForDropboxPopupCode(popup, authUrl, state);
    return exchangeDropboxCodeForToken({
      appKey,
      code,
      codeVerifier,
      redirectUri,
    });
  } catch (error) {
    popup.close();
    throw error;
  }
}

export async function completeDropboxRedirectOAuthIfPresent(
  options: {
    search?: string | URLSearchParams;
    storage?: Storage;
  } = {},
): Promise<DropboxRedirectAccessToken | null> {
  let callback = parseDropboxOAuthCallback(options.search ?? window.location.search);
  if (!callback) return null;

  let transaction = takeDropboxRedirectTransaction(options.storage);
  clearDropboxOAuthCallbackFromUrl();

  if (!transaction) throw new Error("Dropbox authorization state was not found.");
  if (callback.state != transaction.state) {
    throw new Error("Dropbox authorization state did not match.");
  }
  if (callback.error) {
    throw new Error(dropboxOAuthCallbackError(callback.error, callback.errorDescription));
  }
  if (!callback.code) throw new Error("Dropbox authorization did not return a code.");

  let token = await exchangeDropboxCodeForToken({
    appKey: transaction.appKey,
    code: callback.code,
    codeVerifier: transaction.codeVerifier,
    redirectUri: transaction.redirectUri,
  });

  return {
    ...token,
    appKey: transaction.appKey,
    redirectUri: transaction.redirectUri,
    scopes: transaction.scopes,
    state: transaction.state,
  };
}

export function parseDropboxOAuthCallback(
  search: string | URLSearchParams,
): DropboxOAuthCallback | null {
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

export function createDropboxAuthorizeUrl(options: {
  appKey: string;
  codeChallenge: string;
  redirectUri: string;
  scopes?: string[];
  state: string;
}) {
  let url = new URL(DROPBOX_AUTHORIZE_URL);
  url.searchParams.set("client_id", requireDropboxAppKey(options.appKey));
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (options.scopes ?? DEFAULT_DROPBOX_SCOPES).join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("token_access_type", "online");
  return url;
}

export function createDropboxPkceVerifier(bytes: Uint8Array) {
  return base64Url(bytes);
}

export async function createDropboxPkceChallenge(verifier: string) {
  let data = new TextEncoder().encode(verifier);
  let digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(digest));
}

function openDropboxPopup() {
  let popup = window.open("about:blank", "dropbox-oauth", "popup,width=520,height=720");
  if (!popup) return null;
  popup.document.title = "Dropbox authorization";
  popup.focus();
  return popup;
}

async function startDropboxPkceRedirect(options: {
  appKey: string;
  onBeforeRedirect?: (context: DropboxFullPageRedirectContext) => void;
  redirectUri: string;
  scopes: string[];
}): Promise<never> {
  let codeVerifier = randomDropboxPkceVerifier();
  let state = randomDropboxPkceVerifier();
  let codeChallenge = await createDropboxPkceChallenge(codeVerifier);
  let authUrl = createDropboxAuthorizeUrl({
    appKey: options.appKey,
    codeChallenge,
    redirectUri: options.redirectUri,
    scopes: options.scopes,
    state,
  });

  options.onBeforeRedirect?.({
    appKey: options.appKey,
    redirectUri: options.redirectUri,
    scopes: options.scopes,
    state,
  });
  saveDropboxRedirectTransaction({
    appKey: options.appKey,
    codeVerifier,
    createdAt: Date.now(),
    redirectUri: options.redirectUri,
    scopes: options.scopes,
    state,
  });

  window.location.assign(authUrl.href);
  return new Promise<never>(() => {});
}

function waitForDropboxPopupCode(popup: Window, authUrl: URL, expectedState: string) {
  return new Promise<string>((resolve, reject) => {
    let cleanup = () => {
      window.removeEventListener("message", handleMessage);
      window.clearInterval(closedTimer);
    };

    let handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin != window.location.origin || !isDropboxOAuthMessage(event.data)) return;
      if (event.data.state != expectedState) return;

      cleanup();
      popup.close();

      if (event.data.error) {
        reject(new Error(dropboxOAuthCallbackError(event.data.error, event.data.errorDescription)));
      } else if (event.data.code) {
        resolve(event.data.code);
      } else {
        reject(new Error("Dropbox authorization did not return a code."));
      }
    };

    let closedTimer = window.setInterval(() => {
      if (!popup.closed) return;
      cleanup();
      reject(new Error("Dropbox authorization was closed before it completed."));
    }, 500);

    window.addEventListener("message", handleMessage);
    popup.location.href = authUrl.href;
  });
}

async function exchangeDropboxCodeForToken(options: {
  appKey: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<DropboxAccessToken> {
  let body = new URLSearchParams();
  body.set("client_id", options.appKey);
  body.set("code", options.code);
  body.set("code_verifier", options.codeVerifier);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", options.redirectUri);

  let response = await fetch(DROPBOX_TOKEN_URL, {
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  let payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      dropboxTokenError(payload) ?? `Dropbox token exchange failed (${response.status}).`,
    );
  }

  let tokenResponse = parseDropboxTokenResponse(payload);
  if (!tokenResponse) {
    throw new Error("Dropbox token exchange returned an invalid response.");
  }

  return {
    accessToken: tokenResponse.accessToken,
    expiresAt: Date.now() + tokenResponse.expiresIn * 1000,
  };
}

function requireDropboxAppKey(value: string) {
  let appKey = value.trim();
  if (!appKey) throw new Error("Dropbox app key is required.");
  return appKey;
}

function isDropboxOAuthMessage(value: unknown): value is DropboxOAuthMessage {
  if (!value || typeof value != "object") return false;
  let record = value as Record<string, unknown>;
  return record.type == DROPBOX_OAUTH_MESSAGE && typeof record.state == "string";
}

function parseDropboxTokenResponse(value: unknown) {
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

function dropboxTokenError(value: unknown) {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  if (typeof record.error_description == "string") return record.error_description;
  if (typeof record.error == "string") return record.error;
  return null;
}

function dropboxOAuthCallbackError(error: string, description: string | undefined) {
  if (error == "access_denied") return "Dropbox authorization was denied.";
  return description
    ? `Dropbox authorization failed: ${description}`
    : `Dropbox authorization failed: ${error}`;
}

function saveDropboxRedirectTransaction(transaction: DropboxRedirectTransaction) {
  try {
    window.sessionStorage.setItem(DROPBOX_REDIRECT_TRANSACTION_KEY, JSON.stringify(transaction));
  } catch {}
}

function takeDropboxRedirectTransaction(storage = window.sessionStorage) {
  try {
    let raw = storage.getItem(DROPBOX_REDIRECT_TRANSACTION_KEY);
    storage.removeItem(DROPBOX_REDIRECT_TRANSACTION_KEY);
    if (!raw) return null;
    return parseDropboxRedirectTransaction(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseDropboxRedirectTransaction(value: unknown): DropboxRedirectTransaction | null {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  if (
    typeof record.appKey != "string" ||
    typeof record.codeVerifier != "string" ||
    typeof record.createdAt != "number" ||
    typeof record.redirectUri != "string" ||
    typeof record.state != "string" ||
    !Array.isArray(record.scopes)
  ) {
    return null;
  }

  let scopes = record.scopes.filter((scope): scope is string => typeof scope == "string");
  if (!record.appKey.trim() || !record.codeVerifier || !record.redirectUri || !record.state) {
    return null;
  }

  return {
    appKey: record.appKey.trim(),
    codeVerifier: record.codeVerifier,
    createdAt: record.createdAt,
    redirectUri: record.redirectUri,
    scopes,
    state: record.state,
  };
}

function clearDropboxOAuthCallbackFromUrl() {
  if (typeof window == "undefined" || !window.history?.replaceState) return;

  let url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  url.searchParams.delete("state");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function randomDropboxPkceVerifier() {
  let bytes = new Uint8Array(64);
  globalThis.crypto.getRandomValues(bytes);
  return createDropboxPkceVerifier(bytes);
}

function base64Url(bytes: Uint8Array) {
  let binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
