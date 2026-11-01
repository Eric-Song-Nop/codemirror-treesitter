/**
 * Browser OAuth 2.0 authorization-code flow with PKCE (RFC 7636, S256 only).
 *
 * The flow is provider-neutral: a provider supplies a {@link PkceOAuthProviderConfig}
 * with its endpoints, labels, storage keys, and token-response identity parser.
 * Security invariants are fixed here and are not configurable:
 *
 * - The code challenge method is always S256.
 * - The code verifier and state are 64 random bytes each, base64url encoded.
 * - Popup callbacks are only accepted from `window.location.origin` and must carry
 *   the provider's message type and the exact expected state.
 * - The code verifier is written to `sessionStorage` only for a full-page redirect
 *   and is removed as soon as the callback is read.
 *
 * Authorization and token exchange are Effects failing with the typed errors in
 * `oauth-errors.ts`. Interrupting an authorization closes its popup and removes
 * its listeners; interrupting a token exchange aborts the request. The token
 * exchange is never retried, because an authorization code is single-use.
 */
import { Effect, Predicate } from "effect";
import {
  OAuthAuthorizationError,
  OAuthRequestError,
  isRetryableHttpStatus,
} from "./oauth-errors.ts";

export type PkceOAuthProviderConfig<Identity> = {
  authorizeUrl: string;
  /** Extra provider-specific authorization query parameters. */
  authorizeParams?: Readonly<Record<string, string>>;
  /** Field name used for the client id inside the persisted redirect transaction. */
  clientIdField: string;
  /** Human label for the client id, used in validation errors ("app key"). */
  clientIdLabel: string;
  defaultScopes: readonly string[];
  /** Provider display name used in every user-facing error ("Dropbox"). */
  displayName: string;
  messageType: string;
  parseTokenIdentity?: (record: Record<string, unknown>) => Identity | undefined;
  popupName: string;
  redirectTransactionKey: string;
  tokenUrl: string;
};

export type PkceAccessToken<Identity> = {
  accessToken: string;
  expiresAt: number;
  identity?: Identity;
};

export type PkceFullPageRedirectContext = {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
};

export type PkceAuthorizeOptions = {
  allowFullPageRedirect?: boolean;
  clientId: string;
  onBeforeFullPageRedirect?: (context: PkceFullPageRedirectContext) => void;
  redirectUri?: string;
  scopes?: readonly string[];
};

export type PkceRedirectAccessToken<Identity> = PkceAccessToken<Identity> & {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
};

export type PkceOAuthCallback = {
  code?: string;
  error?: string;
  errorDescription?: string;
  state: string;
};

type PkceOAuthMessage = PkceOAuthCallback & { type: string };

type PkceRedirectTransaction = {
  clientId: string;
  codeVerifier: string;
  createdAt: number;
  redirectUri: string;
  scopes: string[];
  state: string;
};

const PKCE_RANDOM_BYTES = 64;
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;
const POPUP_CLOSED_POLL_MS = 250;

export function defaultPkceRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

export function parsePkceOAuthCallback(search: string | URLSearchParams): PkceOAuthCallback | null {
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

export function createPkceVerifier(bytes: Uint8Array) {
  return base64Url(bytes);
}

export const createPkceChallenge = Effect.fn("createPkceChallenge")(function* (verifier: string) {
  let data = new TextEncoder().encode(verifier);
  let digest = yield* Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", data));
  return base64Url(new Uint8Array(digest));
});

export function createPkceOAuthClient<Identity>(config: PkceOAuthProviderConfig<Identity>) {
  let name = config.displayName;

  let authorizationError = (reason: OAuthAuthorizationError["reason"], message: string) =>
    new OAuthAuthorizationError({ message, provider: name, reason });

  let clientIdRequired = () =>
    authorizationError("client-id-required", `${name} ${config.clientIdLabel} is required.`);

  let requireClientId = (value: string) => {
    let clientId = value.trim();
    if (!clientId) throw clientIdRequired();
    return clientId;
  };

  let callbackError = (error: string, description: string | undefined) => {
    if (error == "access_denied") {
      return authorizationError("denied", `${name} authorization was denied.`);
    }
    return authorizationError(
      "failed",
      description
        ? `${name} authorization failed: ${description}`
        : `${name} authorization failed: ${error}`,
    );
  };

  let createAuthorizeUrl = (options: {
    clientId: string;
    codeChallenge: string;
    redirectUri: string;
    scopes?: readonly string[];
    state: string;
  }) => {
    let url = new URL(config.authorizeUrl);
    url.searchParams.set("client_id", requireClientId(options.clientId));
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("redirect_uri", options.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", (options.scopes ?? config.defaultScopes).join(" "));
    url.searchParams.set("state", options.state);
    for (let [key, value] of Object.entries(config.authorizeParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return url;
  };

  let parseTransaction = (value: unknown): PkceRedirectTransaction | null => {
    if (!value || typeof value != "object") return null;
    let record = value as Record<string, unknown>;
    let clientId = record[config.clientIdField];
    if (
      typeof clientId != "string" ||
      typeof record.codeVerifier != "string" ||
      typeof record.createdAt != "number" ||
      typeof record.redirectUri != "string" ||
      typeof record.state != "string" ||
      !Array.isArray(record.scopes)
    ) {
      return null;
    }

    let scopes = record.scopes.filter((scope): scope is string => typeof scope == "string");
    if (!clientId.trim() || !record.codeVerifier || !record.redirectUri || !record.state) {
      return null;
    }

    return {
      clientId: clientId.trim(),
      codeVerifier: record.codeVerifier,
      createdAt: record.createdAt,
      redirectUri: record.redirectUri,
      scopes,
      state: record.state,
    };
  };

  let saveTransaction = (transaction: PkceRedirectTransaction) => {
    let { clientId, ...rest } = transaction;
    try {
      window.sessionStorage.setItem(
        config.redirectTransactionKey,
        JSON.stringify({ [config.clientIdField]: clientId, ...rest }),
      );
    } catch {}
  };

  let takeTransaction = (storage = window.sessionStorage) => {
    try {
      let raw = storage.getItem(config.redirectTransactionKey);
      storage.removeItem(config.redirectTransactionKey);
      if (!raw) return null;
      return parseTransaction(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  let isOAuthMessage = (value: unknown): value is PkceOAuthMessage => {
    if (!value || typeof value != "object") return false;
    let record = value as Record<string, unknown>;
    return record.type == config.messageType && typeof record.state == "string";
  };

  let openPopup = () => {
    let popup = window.open("about:blank", config.popupName, "popup,width=520,height=720");
    if (!popup) return null;
    popup.document.title = `${name} authorization`;
    popup.focus();
    return popup;
  };

  let waitForPopupCode = (popup: Window, authUrl: URL, expectedState: string) =>
    Effect.callback<string, OAuthAuthorizationError>((resume) => {
      let cleanup = () => {
        window.removeEventListener("message", handleMessage);
        window.clearInterval(closedPoll);
        window.clearTimeout(timeout);
      };

      let handleMessage = (event: MessageEvent<unknown>) => {
        if (event.origin != window.location.origin || !isOAuthMessage(event.data)) return;
        if (event.data.state != expectedState) return;

        cleanup();
        closePopup(popup);

        if (event.data.error) {
          resume(Effect.fail(callbackError(event.data.error, event.data.errorDescription)));
        } else if (event.data.code) {
          resume(Effect.succeed(event.data.code));
        } else {
          resume(
            Effect.fail(
              authorizationError("missing-code", `${name} authorization did not return a code.`),
            ),
          );
        }
      };

      let timeout = window.setTimeout(() => {
        cleanup();
        closePopup(popup);
        resume(
          Effect.fail(
            authorizationError(
              "timed-out",
              `${name} authorization timed out. Reconnect ${name} workspace to continue.`,
            ),
          ),
        );
      }, POPUP_TIMEOUT_MS);
      let closedPoll = window.setInterval(() => {
        let closed = false;
        try {
          closed = popup.closed;
        } catch {}
        if (!closed) return;

        cleanup();
        resume(
          Effect.fail(
            authorizationError("closed", `${name} authorization was closed before it completed.`),
          ),
        );
      }, POPUP_CLOSED_POLL_MS);

      window.addEventListener("message", handleMessage);
      popup.location.href = authUrl.href;

      return Effect.sync(() => {
        cleanup();
        closePopup(popup);
      });
    });

  let exchangeCodeForToken = Effect.fn("PkceOAuth.exchangeCodeForToken")(function* (options: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) {
    let body = new URLSearchParams();
    body.set("client_id", options.clientId);
    body.set("code", options.code);
    body.set("code_verifier", options.codeVerifier);
    body.set("grant_type", "authorization_code");
    body.set("redirect_uri", options.redirectUri);

    let { payload, response } = yield* Effect.tryPromise({
      catch: (cause) =>
        new OAuthRequestError({
          cause,
          message: Predicate.isError(cause) ? cause.message : String(cause),
          provider: name,
          request: "token-exchange",
          retryable: true,
        }),
      try: async (signal) => {
        let response = await fetch(config.tokenUrl, {
          body,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
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
          oauthErrorMessage(payload) ?? `${name} token exchange failed (${response.status}).`,
        provider: name,
        request: "token-exchange",
        retryable: isRetryableHttpStatus(response.status),
        status: response.status,
      });
    }

    let tokenResponse = parseTokenResponse(payload, config.parseTokenIdentity);
    if (!tokenResponse) {
      return yield* new OAuthRequestError({
        message: `${name} token exchange returned an invalid response.`,
        provider: name,
        request: "token-exchange",
        retryable: false,
        status: response.status,
      });
    }

    return {
      accessToken: tokenResponse.accessToken,
      expiresAt: Date.now() + tokenResponse.expiresIn * 1000,
      ...(tokenResponse.identity ? { identity: tokenResponse.identity } : {}),
    } satisfies PkceAccessToken<Identity>;
  });

  let startRedirect = Effect.fn("PkceOAuth.startRedirect")(function* (options: {
    clientId: string;
    onBeforeRedirect?: (context: PkceFullPageRedirectContext) => void;
    redirectUri: string;
    scopes: string[];
  }) {
    let codeVerifier = randomPkceValue();
    let state = randomPkceValue();
    let codeChallenge = yield* createPkceChallenge(codeVerifier);
    let authUrl = createAuthorizeUrl({
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
    saveTransaction({
      clientId: options.clientId,
      codeVerifier,
      createdAt: Date.now(),
      redirectUri: options.redirectUri,
      scopes: options.scopes,
      state,
    });

    window.location.assign(authUrl.href);
    // The page is navigating away; the authorization completes on reload.
    return yield* Effect.never;
  });

  return {
    createAuthorizeUrl,

    hasCallback(search: string | URLSearchParams = window.location.search) {
      return Boolean(parsePkceOAuthCallback(search));
    },

    hasRedirectTransaction(storage = window.sessionStorage) {
      try {
        return Boolean(storage.getItem(config.redirectTransactionKey));
      } catch {
        return false;
      }
    },

    hasRedirectCallbackForStoredTransaction(
      search: string | URLSearchParams = window.location.search,
      storage = window.sessionStorage,
    ) {
      let callback = parsePkceOAuthCallback(search);
      if (!callback) return false;

      try {
        let raw = storage.getItem(config.redirectTransactionKey);
        if (!raw) return false;
        let transaction = parseTransaction(JSON.parse(raw));
        return transaction?.state == callback.state;
      } catch {
        return false;
      }
    },

    completePopupIfPresent() {
      let callback = parsePkceOAuthCallback(window.location.search);
      if (!callback || !window.opener) return false;

      let message: PkceOAuthMessage = { ...callback, type: config.messageType };
      window.opener.postMessage(message, window.location.origin);
      window.close();
      return true;
    },

    /**
     * Authorizes in a popup, falling back to a full-page redirect when allowed.
     * A redirect never completes: the page navigates away.
     */
    authorize: Effect.fn("PkceOAuth.authorize")(function* (options: PkceAuthorizeOptions) {
      let clientId = options.clientId.trim();
      if (!clientId) return yield* clientIdRequired();
      let redirectUri = options.redirectUri ?? defaultPkceRedirectUri();
      let scopes = [...(options.scopes ?? config.defaultScopes)];
      let popup = openPopup();
      if (!popup) {
        if (options.allowFullPageRedirect) {
          return yield* startRedirect({
            clientId,
            onBeforeRedirect: options.onBeforeFullPageRedirect,
            redirectUri,
            scopes,
          });
        }
        return yield* authorizationError(
          "popup-blocked",
          `${name} authorization popup was blocked.`,
        );
      }
      let openedPopup = popup;

      return yield* Effect.gen(function* () {
        let codeVerifier = randomPkceValue();
        let state = randomPkceValue();
        let codeChallenge = yield* createPkceChallenge(codeVerifier);
        let authUrl = createAuthorizeUrl({
          clientId,
          codeChallenge,
          redirectUri,
          scopes,
          state,
        });

        let code = yield* waitForPopupCode(openedPopup, authUrl, state);
        return yield* exchangeCodeForToken({ clientId, code, codeVerifier, redirectUri });
      }).pipe(Effect.onError(() => Effect.sync(() => closePopup(openedPopup))));
    }),

    completeRedirectIfPresent: Effect.fn("PkceOAuth.completeRedirectIfPresent")(function* (
      options: { search?: string | URLSearchParams; storage?: Storage } = {},
    ) {
      let callback = parsePkceOAuthCallback(options.search ?? window.location.search);
      if (!callback) return null;

      let transaction = takeTransaction(options.storage);
      clearOAuthCallbackFromUrl();

      if (!transaction) {
        return yield* authorizationError(
          "state-missing",
          `${name} authorization state was not found.`,
        );
      }
      if (callback.state != transaction.state) {
        return yield* authorizationError(
          "state-mismatch",
          `${name} authorization state did not match.`,
        );
      }
      if (callback.error) {
        return yield* callbackError(callback.error, callback.errorDescription);
      }
      if (!callback.code) {
        return yield* authorizationError(
          "missing-code",
          `${name} authorization did not return a code.`,
        );
      }

      let token = yield* exchangeCodeForToken({
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
      } satisfies PkceRedirectAccessToken<Identity>;
    }),
  };
}

export function oauthErrorMessage(value: unknown) {
  if (!value || typeof value != "object") return null;
  let record = value as Record<string, unknown>;
  if (typeof record.error_description == "string") return record.error_description;
  if (typeof record.error == "string") return record.error;
  return null;
}

function parseTokenResponse<Identity>(
  value: unknown,
  parseIdentity: PkceOAuthProviderConfig<Identity>["parseTokenIdentity"],
) {
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
    identity: parseIdentity?.(record),
  };
}

function closePopup(popup: Window) {
  try {
    popup.close();
  } catch {}
}

function clearOAuthCallbackFromUrl() {
  if (typeof window == "undefined" || !window.history?.replaceState) return;

  let url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  url.searchParams.delete("state");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function randomPkceValue() {
  let bytes = new Uint8Array(PKCE_RANDOM_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return createPkceVerifier(bytes);
}

function base64Url(bytes: Uint8Array) {
  let binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
