// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { RelayShareSession } from "@/lib/collaboration/share-relay-client";
import { useSharedFileConnection } from "./useSharedFileConnection";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type ConnectionOptions = {
  onDocumentImported?: () => void;
  onHostSaveAck?: (payload: Uint8Array) => void;
  onShareStatus?: (status: RelayShareSession) => void;
};

const relayMocks = vi.hoisted(() => ({
  connectionOptions: [] as ConnectionOptions[],
}));

vi.mock("@/lib/collaboration/share-relay-connection", () => ({
  ShareRelayConnection: class {
    constructor(options: ConnectionOptions) {
      relayMocks.connectionOptions.push(options);
    }

    close() {}
    connect() {}
    enqueueDocumentUpdate() {}
    pause() {}
  },
}));

let currentApi: ReturnType<typeof useSharedFileConnection> | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  currentApi = null;
  relayMocks.connectionOptions.length = 0;
  vi.restoreAllMocks();
});

describe("useSharedFileConnection", () => {
  it("refreshes the latest visible version after importing a remote document update", async () => {
    let doc = new LoroDoc();
    let remote = new LoroDoc();
    remote.getText("markdown").insert(0, "remote");
    remote.commit();

    await renderHook(doc);
    expect(relayMocks.connectionOptions).toHaveLength(1);

    await act(async () => {
      doc.import(remote.export({ mode: "snapshot" }));
      relayMocks.connectionOptions[0]!.onDocumentImported?.();
    });

    let expectedVersion = doc.oplogVersion();
    expect(currentApi?.latestLocalVersion).toEqual(
      [...expectedVersion.toJSON()].map(([peer, counter]) => [String(peer), counter]),
    );
    expectedVersion.free();

    act(() => root?.unmount());
    root = null;
    remote.free();
    doc.free();
  });

  it("serializes and immediately releases each native version-vector snapshot", async () => {
    let doc = new LoroDoc();
    let originalOplogVersion = doc.oplogVersion.bind(doc);
    let capturedVersions: ReturnType<LoroDoc["oplogVersion"]>[] = [];
    vi.spyOn(doc, "oplogVersion").mockImplementation(() => {
      let version = originalOplogVersion();
      capturedVersions.push(version);
      return version;
    });
    let remote = new LoroDoc();
    remote.getText("markdown").insert(0, "one");
    remote.commit();
    await renderHook(doc);

    await act(async () => {
      doc.import(remote.export({ mode: "snapshot" }));
      relayMocks.connectionOptions[0]!.onDocumentImported?.();
    });
    expect(capturedVersions).toHaveLength(1);
    expect(() => capturedVersions[0]!.toJSON()).toThrow();
    let acknowledgedVersion = currentApi!.latestLocalVersion!;
    await act(async () => {
      relayMocks.connectionOptions[0]!.onHostSaveAck?.(
        new TextEncoder().encode(
          JSON.stringify({
            savedAt: Date.now(),
            shareId: "share-id",
            versionVector: acknowledgedVersion,
          }),
        ),
      );
    });
    expect(currentApi!.hostSavedVersion).toEqual(acknowledgedVersion);

    remote.getText("markdown").insert(3, " two");
    remote.commit();
    let fromVersion = originalOplogVersion();
    let update = remote.export({ mode: "update", from: fromVersion });
    fromVersion.free();
    await act(async () => {
      doc.import(update);
      relayMocks.connectionOptions[0]!.onDocumentImported?.();
    });
    expect(capturedVersions).toHaveLength(2);
    expect(() => capturedVersions[1]!.toJSON()).toThrow();
    expect(currentApi!.latestLocalVersion).not.toEqual(currentApi!.hostSavedVersion);

    act(() => root?.unmount());
    root = null;
    remote.free();
    doc.free();
  });
});

async function renderHook(doc: LoroDoc) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(<SharedFileConnectionHarness doc={doc} />);
  });
}

function SharedFileConnectionHarness({ doc }: { doc: LoroDoc }) {
  currentApi = useSharedFileConnection({
    canConnect: true,
    disabledErrorMessage: "",
    doc,
    joining: false,
    relayOrigin: "https://relay.example",
    refreshSession: async () => session,
    session,
    sessionErrorMessage: "",
    sessionKey: "guest-key",
    shareId: "share-id",
  });
  return null;
}

const session: RelayShareSession = {
  displayName: "note.md",
  expiresAt: Date.now() + 60_000,
  guestCount: 1,
  hostOnline: true,
  peerCount: 2,
  pendingHostSave: false,
  role: "guest",
  sessionToken: "session-token",
  shareExpiresAt: Date.now() + 60_000,
  shareId: "share-id",
};
