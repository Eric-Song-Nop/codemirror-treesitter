// @vitest-environment happy-dom

import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  collabDocumentBroadcastChannelName,
  collabWorkspaceBroadcastChannelName,
  createCollabDocumentBroadcastSync,
  createWorkspaceManifestBroadcastSync,
} from "./document-sync.ts";
import type { WorkspaceBackend } from "@/lib/workspace-backend";

let originalBroadcastChannel: typeof BroadcastChannel | undefined;

beforeEach(() => {
  originalBroadcastChannel = globalThis.BroadcastChannel;
  MemoryBroadcastChannel.channels.clear();
  globalThis.BroadcastChannel = MemoryBroadcastChannel as unknown as typeof BroadcastChannel;
});

afterEach(() => {
  globalThis.BroadcastChannel = originalBroadcastChannel as typeof BroadcastChannel;
  MemoryBroadcastChannel.channels.clear();
});

describe("collab document BroadcastChannel sync", () => {
  it("uses backend and document identity in the channel name", () => {
    expect(collabDocumentBroadcastChannelName(memoryBackend, "doc-1")).toBe(
      "local-md-workspace:local:memory:test:doc:doc-1",
    );
    expect(collabWorkspaceBroadcastChannelName(memoryBackend)).toBe(
      "local-md-workspace:local:memory:test:workspace",
    );
  });

  it("relays local Loro document updates to another sender on the same channel", async () => {
    let first = new LoroDoc();
    let second = new LoroDoc();
    let text = first.getText("markdown");
    let remoteUpdates = 0;

    text.insert(0, "# First\n");
    first.commit();
    second.import(first.export({ mode: "snapshot" }));

    let stopFirst = createCollabDocumentBroadcastSync({
      backend: memoryBackend,
      doc: first,
      docId: "doc-1",
      senderId: "first",
    });
    let stopSecond = createCollabDocumentBroadcastSync({
      backend: memoryBackend,
      doc: second,
      docId: "doc-1",
      onRemoteUpdate: () => {
        remoteUpdates += 1;
      },
      senderId: "second",
    });

    text.insert(text.toString().length, "Shared");
    first.commit();
    await Promise.resolve();

    expect(second.getText("markdown").toString()).toBe("# First\nShared");
    expect(remoteUpdates).toBe(1);

    stopFirst();
    stopSecond();
  });

  it("relays workspace manifest snapshots to another sender on the same channel", async () => {
    let received: Uint8Array[] = [];
    let first = createWorkspaceManifestBroadcastSync({
      backend: memoryBackend,
      senderId: "first",
    });
    let second = createWorkspaceManifestBroadcastSync({
      backend: memoryBackend,
      onRemoteUpdate: (bytes) => {
        received.push(bytes);
      },
      senderId: "second",
    });

    first.broadcast(new Uint8Array([4, 5, 6]));
    await Promise.resolve();

    expect(received).toEqual([new Uint8Array([4, 5, 6])]);

    first.dispose();
    second.dispose();
  });
});

const memoryBackend = {
  id: "memory:test",
  kind: "local",
  name: "Memory",
} as WorkspaceBackend;

class MemoryBroadcastChannel extends EventTarget {
  static channels = new Map<string, Set<MemoryBroadcastChannel>>();

  constructor(public readonly name: string) {
    super();
    let channels = MemoryBroadcastChannel.channels.get(name);
    if (!channels) {
      channels = new Set();
      MemoryBroadcastChannel.channels.set(name, channels);
    }
    channels.add(this);
  }

  close() {
    MemoryBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  postMessage(message: unknown) {
    for (let channel of MemoryBroadcastChannel.channels.get(this.name) ?? []) {
      channel.dispatchEvent(new MessageEvent("message", { data: message }));
    }
  }
}
