import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  authorizeGoogleDriveWithPkce,
  completeGoogleDriveRedirectOAuthIfPresent,
  createGoogleDriveAuthorizeUrl,
  createGoogleDrivePkceChallenge,
  createGoogleDrivePkceVerifier,
  DEFAULT_GOOGLE_DRIVE_SCOPES,
  fetchGoogleDriveAccountIdentity,
  GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY,
  hasGoogleDriveOAuthCallback,
  hasGoogleDriveRedirectTransaction,
  parseGoogleDriveOAuthCallback,
} from "./google-drive-oauth.ts";

type TestGoogleDriveTokenClientConfig = {
  callback: (response: {
    access_token?: string;
    error?: string;
    expires_in?: number | string;
  }) => void;
  client_id: string;
  error_callback?: (error: { type?: string }) => void;
  include_granted_scopes?: boolean;
  scope: string;
};

describe("Google Drive OAuth PKCE helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the RFC 7636 S256 code challenge", async () => {
    await expect(
      createGoogleDrivePkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("encodes verifiers without base64 padding or unsafe URL characters", () => {
    let verifier = createGoogleDrivePkceVerifier(new Uint8Array([0, 255, 254, 253, 1, 2]));

    expect(verifier).not.toContain("+");
    expect(verifier).not.toContain("/");
    expect(verifier).not.toContain("=");
  });

  it("builds a short-lived Google Drive authorization URL", () => {
    let url = createGoogleDriveAuthorizeUrl({
      clientId: " client-id ",
      codeChallenge: "challenge",
      redirectUri: "http://127.0.0.1:5173/",
      state: "state",
    });

    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5173/");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(DEFAULT_GOOGLE_DRIVE_SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe("state");
  });

  it("defaults to app-created Google Drive file access", () => {
    expect(DEFAULT_GOOGLE_DRIVE_SCOPES).toEqual(["https://www.googleapis.com/auth/drive.file"]);
  });

  it("parses callback codes and errors", () => {
    expect(parseGoogleDriveOAuthCallback("?state=s1&code=c1")).toEqual({
      code: "c1",
      error: undefined,
      errorDescription: undefined,
      state: "s1",
    });

    expect(
      parseGoogleDriveOAuthCallback("state=s2&error=access_denied&error_description=Denied"),
    ).toEqual({
      code: undefined,
      error: "access_denied",
      errorDescription: "Denied",
      state: "s2",
    });
  });

  it("ignores incomplete callback URLs", () => {
    expect(parseGoogleDriveOAuthCallback("?code=c1")).toBeNull();
    expect(parseGoogleDriveOAuthCallback("?state=s1")).toBeNull();
  });

  it("detects complete OAuth callback URLs and stored redirect transactions", () => {
    let values = new Map<string, string>();
    let storage = memoryStorage(values);

    expect(hasGoogleDriveOAuthCallback("?state=s1&code=c1")).toBe(true);
    expect(hasGoogleDriveOAuthCallback("?state=s1&error=access_denied")).toBe(true);
    expect(hasGoogleDriveOAuthCallback("?state=s1")).toBe(false);
    expect(hasGoogleDriveRedirectTransaction(storage)).toBe(false);

    values.set(GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY, "{}");
    expect(hasGoogleDriveRedirectTransaction(storage)).toBe(true);
  });

  it("requests Google Drive access tokens through Google Identity Services", async () => {
    let tokenClientConfig: TestGoogleDriveTokenClientConfig | null = null;
    let requestAccessToken = vi.fn();
    let initTokenClient = vi.fn((config) => {
      tokenClientConfig = config;
      return { requestAccessToken };
    });
    vi.stubGlobal("window", {
      google: {
        accounts: {
          oauth2: { initTokenClient },
        },
      },
    });

    let promise = authorizeGoogleDriveWithPkce({
      clientId: " client-id ",
      redirectUri: "http://127.0.0.1:5173/",
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });
    await waitFor(() => requestAccessToken.mock.calls.length == 1);
    let config = requireTokenClientConfig(tokenClientConfig);
    config.callback({ access_token: "access-token", expires_in: "60" });

    await expect(promise).resolves.toMatchObject({
      accessToken: "access-token",
      expiresAt: expect.any(Number),
    });
    expect(initTokenClient).toHaveBeenCalledTimes(1);
    expect(config).toMatchObject({
      client_id: "client-id",
      include_granted_scopes: true,
      scope: "https://www.googleapis.com/auth/drive.file",
    });
  });

  it("maps Google Identity Services popup and denied errors", async () => {
    let tokenClientConfig: TestGoogleDriveTokenClientConfig | null = null;
    vi.stubGlobal("window", {
      google: {
        accounts: {
          oauth2: {
            initTokenClient: vi.fn((config) => {
              tokenClientConfig = config;
              return { requestAccessToken: vi.fn() };
            }),
          },
        },
      },
    });

    let popupBlocked = authorizeGoogleDriveWithPkce({ clientId: "client-id" });
    await waitFor(() => Boolean(tokenClientConfig));
    requireTokenClientConfig(tokenClientConfig).error_callback?.({ type: "popup_failed_to_open" });
    await expect(popupBlocked).rejects.toThrow("Google Drive authorization popup was blocked.");

    tokenClientConfig = null;
    let denied = authorizeGoogleDriveWithPkce({ clientId: "client-id" });
    await waitFor(() => Boolean(tokenClientConfig));
    requireTokenClientConfig(tokenClientConfig).callback({ error: "access_denied" });
    await expect(denied).rejects.toThrow("Google Drive authorization was denied");
  });

  it("completes full-page redirect OAuth from a stored PKCE transaction", async () => {
    let values = new Map<string, string>();
    let storage = memoryStorage(values);
    values.set(
      GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY,
      JSON.stringify({
        clientId: "client-id",
        codeVerifier: "verifier",
        createdAt: 1,
        redirectUri: "http://127.0.0.1:5173/",
        scopes: DEFAULT_GOOGLE_DRIVE_SCOPES,
        state: "state",
      }),
    );

    let replaceState = vi.fn();
    let fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      tokenResponse({ access_token: "access-token", expires_in: 60 }),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", {
      history: { replaceState },
      location: {
        href: "http://127.0.0.1:5173/?state=state&code=code",
        search: "?state=state&code=code",
      },
    });

    let token = await completeGoogleDriveRedirectOAuthIfPresent({
      search: "?state=state&code=code",
      storage,
    });

    expect(token?.accessToken).toBe("access-token");
    expect(token?.clientId).toBe("client-id");
    expect(token?.redirectUri).toBe("http://127.0.0.1:5173/");
    expect(token?.scopes).toEqual(DEFAULT_GOOGLE_DRIVE_SCOPES);
    expect(values.has(GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY)).toBe(false);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");

    let body = fetch.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get("client_id")).toBe("client-id");
    expect((body as URLSearchParams).get("code")).toBe("code");
    expect((body as URLSearchParams).get("code_verifier")).toBe("verifier");
    expect((body as URLSearchParams).get("grant_type")).toBe("authorization_code");
    expect((body as URLSearchParams).get("redirect_uri")).toBe("http://127.0.0.1:5173/");
  });

  it("accepts Google Drive token responses with string expires_in values", async () => {
    let values = new Map<string, string>();
    let storage = memoryStorage(values);
    values.set(
      GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY,
      JSON.stringify({
        clientId: "client-id",
        codeVerifier: "verifier",
        createdAt: 1,
        redirectUri: "http://127.0.0.1:5173/",
        scopes: DEFAULT_GOOGLE_DRIVE_SCOPES,
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

    let token = await completeGoogleDriveRedirectOAuthIfPresent({
      search: "?state=state&code=code",
      storage,
    });

    expect(token?.accessToken).toBe("token");
    expect(token?.expiresAt).toEqual(expect.any(Number));
  });

  it("fetches Google Drive account identity from Drive about", async () => {
    let fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      tokenResponse({ user: { permissionId: "permission-123" } }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(fetchGoogleDriveAccountIdentity("access-token")).resolves.toEqual({
      id: "permission-123",
      kind: "account",
    });

    let url = fetch.mock.calls[0]?.[0] as URL;
    expect(`${url.origin}${url.pathname}`).toBe("https://www.googleapis.com/drive/v3/about");
    expect(url.searchParams.get("fields")).toBe("user(permissionId)");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer access-token",
      },
    });
  });

  it("rejects full-page redirect callbacks with mismatched state", async () => {
    let values = new Map<string, string>();
    let storage = memoryStorage(values);
    values.set(
      GOOGLE_DRIVE_REDIRECT_TRANSACTION_KEY,
      JSON.stringify({
        clientId: "client-id",
        codeVerifier: "verifier",
        createdAt: 1,
        redirectUri: "http://127.0.0.1:5173/",
        scopes: DEFAULT_GOOGLE_DRIVE_SCOPES,
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
      completeGoogleDriveRedirectOAuthIfPresent({
        search: "?state=callback-state&code=code",
        storage,
      }),
    ).rejects.toThrow("Google Drive authorization state did not match.");
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

function requireTokenClientConfig(
  config: TestGoogleDriveTokenClientConfig | null,
): TestGoogleDriveTokenClientConfig {
  if (!config) throw new Error("Google Drive token client was not initialized.");
  return config;
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}
