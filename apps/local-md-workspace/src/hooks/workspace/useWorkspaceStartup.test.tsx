// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceBackend } from "@/lib/workspace-backend";

const dropboxOAuthMocks = vi.hoisted(() => ({
  completeRedirect: vi.fn(),
}));

vi.mock("@/lib/dropbox-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dropbox-oauth")>()),
  completeDropboxRedirectOAuthIfPresent: dropboxOAuthMocks.completeRedirect,
}));

vi.mock("@/lib/workspace/dropbox-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/dropbox-config")>()),
  isDropboxRedirectCallbackWindow: () => true,
}));

import { useWorkspaceStartup } from "./useWorkspaceStartup";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  dropboxOAuthMocks.completeRedirect.mockReset();
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe("useWorkspaceStartup", () => {
  it("reuses redirect OAuth completion across the StrictMode effect replay", async () => {
    let completion = createDeferred<{
      accessToken: string;
      appKey: string;
      expiresAt: number;
      redirectUri: string;
      scopes: string[];
      state: string;
    } | null>();
    dropboxOAuthMocks.completeRedirect
      .mockReturnValueOnce(completion.promise)
      .mockResolvedValueOnce(null);
    let options = createStartupOptions();

    await act(async () => {
      root?.render(
        <StrictMode>
          <StartupHarness options={options} />
        </StrictMode>,
      );
    });
    await act(async () => {
      completion.resolve({
        accessToken: "access-token",
        appKey: "app-key",
        expiresAt: 1234,
        redirectUri: "https://grove.example/",
        scopes: ["files.content.write"],
        state: "oauth-state",
      });
      await completion.promise;
    });

    expect(dropboxOAuthMocks.completeRedirect).toHaveBeenCalledOnce();
    expect(options.setDropboxRedirectAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "access-token", appKey: "app-key" }),
    );
    expect(options.openDropboxWorkspace).toHaveBeenCalledWith(
      { appKey: "app-key", root: undefined },
      { restoreDraft: null, skipSaveCurrent: true },
    );
  });
});

function StartupHarness({ options }: { options: ReturnType<typeof createStartupOptions> }) {
  useWorkspaceStartup(options);
  return null;
}

function createStartupOptions() {
  let selectedFile = {
    kind: "file" as const,
    name: "open.md",
    path: "open.md",
  };
  let workspaceBackend: WorkspaceBackend = {
    id: "local:test",
    kind: "local",
    name: "test",
    createFile: async () => null,
    deleteFile: async () => {},
    readFile: async () => "",
    readTree: async () => ({ children: [], kind: "directory", name: "test", path: "" }),
    renameFile: async (_path, rawName) => rawName,
    writeFile: async () => {},
  };

  return {
    browserSupported: false,
    clearDropboxAccessToken: vi.fn(),
    loadTree: vi.fn(async () => {}),
    openDropboxWorkspace: vi.fn(async () => true),
    openSingleFileDraft: vi.fn(async () => {}),
    selectedFile,
    selectedFileRef: { current: selectedFile },
    setBusy: vi.fn(),
    setDropboxConnecting: vi.fn(),
    setDropboxRedirectAccessToken: vi.fn(),
    setErrorMessage: vi.fn(),
    setRestoreChecking: vi.fn(),
    setRetryLoadPath: vi.fn(),
    setSidebarOpen: vi.fn(),
    setStoredLocalWorkspace: vi.fn(),
    setWorkspaceBackend: vi.fn(),
    storedDropboxConfig: null,
    storedLocalWorkspace: null,
    storedWorkspaceKind: null,
    workspaceBackend,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
