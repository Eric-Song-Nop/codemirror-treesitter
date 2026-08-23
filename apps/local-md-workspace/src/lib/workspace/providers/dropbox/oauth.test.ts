import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  authorizeDropboxWithPkce,
  completeDropboxRedirectOAuthIfPresent,
  createDropboxAuthorizeUrl,
  createDropboxPkceChallenge,
  createDropboxPkceVerifier,
  DEFAULT_DROPBOX_SCOPES,
  DROPBOX_AUTHORIZE_URL,
  DROPBOX_REDIRECT_TRANSACTION_KEY,
  fetchDropboxAccountIdentity,
  hasDropboxOAuthCallback,
  hasDropboxRedirectTransaction,
  parseDropboxOAuthCallback,
} from "./oauth.ts";

describe("Dropbox OAuth PKCE helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the RFC 7636 S256 code challenge", async () => {
    await expect(
      createDropboxPkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("encodes verifiers without base64 padding or unsafe URL characters", () => {
    let verifier = createDropboxPkceVerifier(new Uint8Array([0, 255, 254, 253, 1, 2]));

    expect(verifier).not.toContain("+");
    expect(verifier).not.toContain("/");
    expect(verifier).not.toContain("=");
  });

  it("builds a short-lived Dropbox authorization URL", () => {
    let url = createDropboxAuthorizeUrl({
      appKey: " app-key ",
      codeChallenge: "challenge",
      redirectUri: "http://127.0.0.1:5173/",
      state: "state",
    });

    expect(url.origin).toBe("https://www.dropbox.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("app-key");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5173/");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(DEFAULT_DROPBOX_SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe("state");
    expect(url.searchParams.get("token_access_type")).toBe("online");
  });

  it("parses callback codes and errors", () => {
    expect(parseDropboxOAuthCallback("?state=s1&code=c1")).toEqual({
      code: "c1",
      error: undefined,
      errorDescription: undefined,
      state: "s1",
    });

    expect(
      parseDropboxOAuthCallback("state=s2&error=access_denied&error_description=Denied"),
    ).toEqual({
      code: undefined,
      error: "access_denied",
      errorDescription: "Denied",
      state: "s2",
    });
  });

  it("ignores incomplete callback URLs", () => {
    expect(parseDropboxOAuthCallback("?code=c1")).toBeNull();
    expect(parseDropboxOAuthCallback("?state=s1")).toBeNull();
  });

  it("detects complete OAuth callback URLs and stored redirect transactions", () => {
    let values = new Map<string, string>();
    let storage = memoryStorage(values);

    expect(hasDropboxOAuthCallback("?state=s1&code=c1")).toBe(true);
    expect(hasDropboxOAuthCallback("?state=s1&error=access_denied")).toBe(true);
    expect(hasDropboxOAuthCallback("?state=s1")).toBe(false);
    expect(hasDropboxRedirectTransaction(storage)).toBe(false);

    values.set(DROPBOX_REDIRECT_TRANSACTION_KEY, "{}");
    expect(hasDropboxRedirectTransaction(storage)).toBe(true);
  });

  it("falls back to a full-page PKCE redirect when the popup is blocked", async () => {
    let values = new Map<string, string>();
    let assign = vi.fn();
    let onBeforeRedirect = vi.fn();
    vi.stubGlobal("window", {
      location: { assign },
      open: vi.fn(() => null),
      sessionStorage: memoryStorage(values),
    });

    void authorizeDropboxWithPkce({
      allowFullPageRedirect: true,
      appKey: " app-key ",
      onBeforeFullPageRedirect: onBeforeRedirect,
      redirectUri: "http://127.0.0.1:5173/",
      scopes: ["files.metadata.read"],
    }).catch(() => {});
    await waitFor(() => assign.mock.calls.length == 1);

    expect(onBeforeRedirect).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);

    let authUrl = new URL(assign.mock.calls[0]![0]);
    expect(authUrl.origin).toBe("https://www.dropbox.com");
    expect(authUrl.searchParams.get("client_id")).toBe("app-key");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5173/");
    expect(authUrl.searchParams.get("scope")).toBe("files.metadata.read");
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("token_access_type")).toBe("online");

    let transaction = JSON.parse(values.get(DROPBOX_REDIRECT_TRANSACTION_KEY)!);
    let redirectContext = onBeforeRedirect.mock.calls[0]![0];
    expect(transaction.appKey).toBe("app-key");
    expect(transaction.redirectUri).toBe("http://127.0.0.1:5173/");
    expect(transaction.scopes).toEqual(["files.metadata.read"]);
    expect(transaction.state).toBe(authUrl.searchParams.get("state"));
    expect(transaction.state).toBe(redirectContext.state);
    expect(transaction.codeVerifier).toEqual(expect.any(String));
    expect(authUrl.searchParams.get("code_challenge")).toEqual(expect.any(String));
  });

  it("rejects promptly when the Dropbox authorization popup is closed", async () => {
    let popupClosed = false;
    let popup = {
      close: vi.fn(() => {
        popupClosed = true;
      }),
      document: { title: "" },
      focus: vi.fn(),
      get closed() {
        return popupClosed;
      },
      location: { href: "about:blank" },
    };
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      open: vi.fn(() => popup),
      removeEventListener: vi.fn(),
      setInterval: globalThis.setInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
    });

    let authorization = authorizeDropboxWithPkce({
      appKey: "app-key",
      redirectUri: "http://127.0.0.1:5173/",
    });
    await waitFor(() => popup.location.href.startsWith(DROPBOX_AUTHORIZE_URL));
    popupClosed = true;

    await expect(authorization).rejects.toThrow(
      "Dropbox authorization was closed before it completed.",
    );
  }, 1000);

  it("completes full-page redirect OAuth from a stored PKCE transaction", async () => {
    let values = new Map<string, string>();
    let storage = memoryStorage(values);
    values.set(
      DROPBOX_REDIRECT_TRANSACTION_KEY,
      JSON.stringify({
        appKey: "app-key",
        codeVerifier: "verifier",
        createdAt: 1,
        redirectUri: "http://127.0.0.1:5173/",
        scopes: DEFAULT_DROPBOX_SCOPES,
        state: "state",
      }),
    );

    let replaceState = vi.fn();
    let fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      tokenResponse({ access_token: "access-token", account_id: "dbid:account", expires_in: 60 }),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", {
      history: { replaceState },
      location: {
        href: "http://127.0.0.1:5173/?state=state&code=code",
        search: "?state=state&code=code",
      },
    });

    let token = await completeDropboxRedirectOAuthIfPresent({
      search: "?state=state&code=code",
      storage,
    });

    expect(token?.accessToken).toBe("access-token");
    expect(token?.appKey).toBe("app-key");
    expect(token?.identity).toEqual({ id: "dbid:account", kind: "account" });
    expect(token?.redirectUri).toBe("http://127.0.0.1:5173/");
    expect(token?.scopes).toEqual(DEFAULT_DROPBOX_SCOPES);
    expect(values.has(DROPBOX_REDIRECT_TRANSACTION_KEY)).toBe(false);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");

    let body = fetch.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get("client_id")).toBe("app-key");
    expect((body as URLSearchParams).get("code")).toBe("code");
    expect((body as URLSearchParams).get("code_verifier")).toBe("verifier");
    expect((body as URLSearchParams).get("grant_type")).toBe("authorization_code");
  });

  it("accepts Dropbox token responses with string expires_in values", async () => {
    let values = new Map<string, string>();
    let storage = memoryStorage(values);
    values.set(
      DROPBOX_REDIRECT_TRANSACTION_KEY,
      JSON.stringify({
        appKey: "app-key",
        codeVerifier: "verifier",
        createdAt: 1,
        redirectUri: "http://127.0.0.1:5173/",
        scopes: DEFAULT_DROPBOX_SCOPES,
        state: "state",
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse({ access_token: "token", expires_in: "60" })),
    );
    vi.stubGlobal("window", {
      history: { replaceState: vi.fn() },
      location: {
        href: "http://127.0.0.1:5173/?state=state&code=code",
        search: "?state=state&code=code",
      },
    });

    let token = await completeDropboxRedirectOAuthIfPresent({
      search: "?state=state&code=code",
      storage,
    });

    expect(token?.accessToken).toBe("token");
    expect(token?.expiresAt).toEqual(expect.any(Number));
  });

  it("fetches Dropbox account identity from the current account API", async () => {
    let fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      tokenResponse({ account_id: "dbid:fetched-account" }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(fetchDropboxAccountIdentity("access-token")).resolves.toEqual({
      id: "dbid:fetched-account",
      kind: "account",
    });

    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.dropboxapi.com/2/users/get_current_account");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      body: "null",
      headers: {
        Authorization: "Bearer access-token",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  });

  it("rejects full-page redirect callbacks with mismatched state", async () => {
    let values = new Map<string, string>();
    let storage = memoryStorage(values);
    values.set(
      DROPBOX_REDIRECT_TRANSACTION_KEY,
      JSON.stringify({
        appKey: "app-key",
        codeVerifier: "verifier",
        createdAt: 1,
        redirectUri: "http://127.0.0.1:5173/",
        scopes: DEFAULT_DROPBOX_SCOPES,
        state: "expected-state",
      }),
    );

    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", {
      history: { replaceState: vi.fn() },
      location: {
        href: "http://127.0.0.1:5173/?state=callback-state&code=code",
        search: "?state=callback-state&code=code",
      },
    });

    await expect(
      completeDropboxRedirectOAuthIfPresent({
        search: "?state=callback-state&code=code",
        storage,
      }),
    ).rejects.toThrow("Dropbox authorization state did not match.");
  });
});

function memoryStorage(values: Map<string, string>): Storage {
  return {
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    get length() {
      return values.size;
    },
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  };
}

function tokenResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}
