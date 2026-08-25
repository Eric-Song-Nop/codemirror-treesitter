// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceCollaborativeDocument } from "@/lib/workspace/documents";
import type { RelayShareSession } from "@/lib/collaboration/share-relay-client";
import type { OwnerShareRecord } from "@/lib/collaboration/share-storage";
import { createDocumentSession } from "@/lib/workspace/document-session";
import { documentSourceRef } from "@/lib/workspace/source-identity";
import { createMemoryWorkspaceRuntime } from "@/test/memory-workspace-runtime";
import { useOwnerShareHost } from "./useOwnerShareHost";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type ConnectionOptions = {
  refreshSessionToken?: (signal: AbortSignal) => Promise<string>;
};

const relayMocks = vi.hoisted(() => ({
  connectionOptions: [] as ConnectionOptions[],
  createRelayShareSession: vi.fn(),
}));

vi.mock("@/lib/collaboration/share-relay-client", () => ({
  configuredShareRelayOrigin: () => "https://relay.example",
  createRelayShareSession: relayMocks.createRelayShareSession,
}));

vi.mock("@/lib/collaboration/share-relay-connection", () => ({
  ShareRelayConnection: class {
    constructor(options: ConnectionOptions) {
      relayMocks.connectionOptions.push(options);
    }

    close() {}
    connect() {}
    enqueueDocumentUpdate() {}
    enqueueHostSaveAck() {}
    flushNow() {}
  },
}));

type OwnerShareHostApi = ReturnType<typeof useOwnerShareHost>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let currentApi: OwnerShareHostApi | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  relayMocks.connectionOptions.length = 0;
  relayMocks.createRelayShareSession.mockReset();
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  currentApi = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useOwnerShareHost session refresh", () => {
  it("reissues an owner session with the host secret and refresh abort signal", async () => {
    relayMocks.createRelayShareSession
      .mockResolvedValueOnce(relaySession("initial-token"))
      .mockImplementationOnce(
        async (
          _origin: string,
          _shareId: string,
          _role: string,
          _secret: string,
          fetchImpl: typeof fetch,
        ) => {
          await fetchImpl("https://relay.example/refresh", { method: "POST" });
          return relaySession("fresh-token");
        },
      );
    let fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    let { record, session } = ownerShareFixture();
    localStorage.setItem(record.hostSecretRef, "host-secret");
    await renderOwnerShareHostHook();

    await act(async () => {
      await currentApi!.startOwnerShareHost(record, session);
    });
    expect(relayMocks.connectionOptions).toHaveLength(1);
    let refreshSessionToken = relayMocks.connectionOptions[0]!.refreshSessionToken;
    expect(refreshSessionToken).toBeTypeOf("function");
    let controller = new AbortController();

    let token = await refreshSessionToken!(controller.signal);

    expect(token).toBe("fresh-token");
    expect(relayMocks.createRelayShareSession).toHaveBeenLastCalledWith(
      "https://relay.example",
      record.shareId,
      "host",
      "host-secret",
      expect.any(Function),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});

async function renderOwnerShareHostHook() {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(<OwnerShareHostHarness />);
  });
}

function OwnerShareHostHarness() {
  currentApi = useOwnerShareHost({
    setActiveShareRecord: vi.fn(),
    setShareError: vi.fn(),
  });
  return null;
}

function ownerShareFixture() {
  let runtime = createMemoryWorkspaceRuntime([["note.md", ""]], {
    id: "workspace-id",
    name: "Workspace",
  });
  let file = { kind: "file" as const, name: "note.md", path: "note.md" };
  let sourceRef = documentSourceRef(runtime.identity, file.path);
  let record: OwnerShareRecord = {
    backendKind: runtime.identity.kind,
    createdAt: Date.now(),
    displayName: file.name,
    expiresAt: Date.now() + 60_000,
    guestSecretHash: "guest-hash",
    hostSecretHash: "host-hash",
    hostSecretRef: "test-host-secret",
    localFileId: "doc-id",
    materializedHash: "materialized-hash",
    path: file.path,
    schemaVersion: 2,
    shareId: "share-id",
    sourceRef,
    workspaceId: runtime.identity.id,
  };
  let doc = new LoroDoc();
  let collabDocument = {
    loroDoc: doc,
    docId: "doc-id",
    path: file.path,
    subscribe: () => () => {},
  } as unknown as WorkspaceCollaborativeDocument;
  return {
    record,
    session: createDocumentSession(runtime, file, collabDocument),
  };
}

function relaySession(sessionToken: string): RelayShareSession {
  return {
    displayName: "note.md",
    expiresAt: Date.now() + 60_000,
    guestCount: 0,
    hostOnline: true,
    peerCount: 1,
    pendingHostSave: false,
    role: "host",
    sessionToken,
    shareExpiresAt: Date.now() + 3_600_000,
    shareId: "share-id",
  };
}

function memoryStorage(): Storage {
  let records = new Map<string, string>();
  return {
    get length() {
      return records.size;
    },
    clear: () => records.clear(),
    getItem: (key) => records.get(key) ?? null,
    key: (index) => [...records.keys()][index] ?? null,
    removeItem: (key) => void records.delete(key),
    setItem: (key, value) => void records.set(key, value),
  };
}
