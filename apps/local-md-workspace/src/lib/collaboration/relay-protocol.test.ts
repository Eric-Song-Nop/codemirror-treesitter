import { describe, expect, it } from "vite-plus/test";
import {
  RelayWireKind,
  decodeRelayWireFrame,
  encodeRelayWireBatch,
  encodeRelayWireMessage,
} from "./relay-protocol.ts";

describe("collaboration relay protocol", () => {
  it("round-trips single and batched binary frames", () => {
    expect(
      decodeRelayWireFrame(encodeRelayWireMessage(RelayWireKind.Doc, new Uint8Array([1]))),
    ).toEqual([
      {
        kind: RelayWireKind.Doc,
        payload: new Uint8Array([1]),
      },
    ]);

    let batch = encodeRelayWireBatch([
      { kind: RelayWireKind.Doc, payload: new Uint8Array([1, 2]) },
      { kind: RelayWireKind.Presence, payload: new Uint8Array([3]) },
      { kind: RelayWireKind.HostSaveAck, payload: new Uint8Array([4]) },
      { kind: RelayWireKind.ShareStatus, payload: new Uint8Array([5]) },
    ]);

    expect(decodeRelayWireFrame(batch)).toEqual([
      { kind: RelayWireKind.Doc, payload: new Uint8Array([1, 2]) },
      { kind: RelayWireKind.Presence, payload: new Uint8Array([3]) },
      { kind: RelayWireKind.HostSaveAck, payload: new Uint8Array([4]) },
      { kind: RelayWireKind.ShareStatus, payload: new Uint8Array([5]) },
    ]);
  });
});
