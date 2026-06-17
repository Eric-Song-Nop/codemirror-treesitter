// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { ThemeProvider } from "@/theme";
import { SharedFileEditor } from "./SharedFileEditor";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const relayOrigin = "https://relay.test";
const shareId = "B".repeat(22);
const guestSecret = "A".repeat(43);
const sharedFileHref = `https://app.test/share/${shareId}#key=${guestSecret}`;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let activeQueryClient: QueryClient | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  activeQueryClient?.clear();
  activeQueryClient = null;
  container?.remove();
  container = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SharedFileEditor", () => {
  it("shows a joining spinner without putting the raw guest secret in the query key", async () => {
    let pendingResponse = new Promise<Response>(() => {});
    let fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pendingResponse);
    vi.stubGlobal("fetch", fetchMock);

    let queryClient = await renderSharedFileEditor();

    expect(document.body.textContent).toContain("Joining shared file");
    expect(document.querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();

    let [, requestInit] = fetchMock.mock.calls[0]!;
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);

    let queryKeys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(JSON.stringify(queryKeys)).toContain("shared-session");
    expect(JSON.stringify(queryKeys)).not.toContain(guestSecret);
  });

  it("retries failed join requests with pending feedback", async () => {
    let retryResponse = new Promise<Response>(() => {});
    let fetchMock = vi
      .fn((_input: RequestInfo | URL, _init?: RequestInit) => retryResponse)
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockImplementationOnce((_input, _init) => retryResponse);
    vi.stubGlobal("fetch", fetchMock);

    await renderSharedFileEditor();
    await waitForAssertion(() => {
      expect(document.body.textContent).toContain("Could not join shared file (403).");
    });

    let retryButton = buttonWithText("Retry");
    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await waitForAssertion(() => {
      let connectingButton = buttonWithText("Connecting");
      expect(connectingButton.disabled).toBe(true);
      expect(document.querySelector('[data-slot="spinner"]')).not.toBeNull();
    });
  });
});

async function renderSharedFileEditor(href = sharedFileHref) {
  vi.stubEnv("VITE_LOCAL_MD_SHARE_RELAY_ORIGIN", relayOrigin);

  if (!container) {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  }

  let queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  activeQueryClient = queryClient;

  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider initialTheme="github-light">
          <SharedFileEditor href={href} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });

  return queryClient;
}

async function waitForAssertion(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function buttonWithText(text: string) {
  let button = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Could not find button containing "${text}".`);
  }
  return button;
}
