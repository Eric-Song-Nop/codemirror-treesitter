// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { RelayShareSession } from "@/lib/collaboration/share-relay-client";
import { useSharedFileSession } from "./useSharedFileSession";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type SharedSessionApi = ReturnType<typeof useSharedFileSession> & {
  refreshSession: (signal: AbortSignal) => Promise<RelayShareSession>;
};

let currentApi: SharedSessionApi | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  queryClient?.clear();
  queryClient = null;
  currentApi = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useSharedFileSession", () => {
  it("obtains a fresh guest session with the connection refresh abort signal", async () => {
    let fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse("initial-token"))
      .mockResolvedValueOnce(sessionResponse("fresh-token"));
    vi.stubGlobal("fetch", fetchMock);
    await renderSessionHook();
    await waitFor(() => currentApi?.session?.sessionToken == "initial-token");
    let controller = new AbortController();

    let refreshed = await currentApi!.refreshSession(controller.signal);

    expect(refreshed.sessionToken).toBe("fresh-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    let [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).href).toBe("https://relay.example/api/shares/share-id/session");
    expect(init?.signal).toBe(controller.signal);
    expect(typeof init?.body).toBe("string");
    expect(JSON.parse(init!.body as string)).toEqual({ role: "guest", secret: "guest-secret" });
  });
});

async function renderSessionHook() {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient!}>
        <SessionHarness />
      </QueryClientProvider>,
    );
  });
}

function SessionHarness() {
  currentApi = useSharedFileSession({
    enabled: true,
    guestSecret: "guest-secret",
    relayOrigin: "https://relay.example",
    shareId: "share-id",
  }) as SharedSessionApi;
  return null;
}

function sessionResponse(sessionToken: string) {
  return Response.json({
    displayName: "note.md",
    expiresAt: Date.now() + 60_000,
    guestCount: 1,
    hostOnline: true,
    peerCount: 2,
    pendingHostSave: false,
    role: "guest",
    sessionToken,
    shareExpiresAt: Date.now() + 3_600_000,
    shareId: "share-id",
  } satisfies RelayShareSession);
}

async function waitFor(predicate: () => boolean) {
  for (let attempts = 0; attempts < 20; attempts++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for hook state.");
}
