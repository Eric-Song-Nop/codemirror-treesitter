// @vitest-environment happy-dom

import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  collabDocumentBroadcastChannelName,
  createCollabDocumentBroadcastSync,
} from "./document-sync.ts";
import type { WorkspaceIdentity } from "@/lib/workspace/runtime/types";

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
    expect(collabDocumentBroadcastChannelName(memoryIdentity, "doc-1")).toBe(
      "local-md-workspace:local:memory:test:doc:doc-1",
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
      identity: memoryIdentity,
      doc: first,
      docId: "doc-1",
      senderId: "first",
    });
    let stopSecond = createCollabDocumentBroadcastSync({
      identity: memoryIdentity,
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
});

const memoryIdentity = {
  id: "memory:test",
  kind: "local",
  name: "Memory",
} satisfies WorkspaceIdentity;

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
