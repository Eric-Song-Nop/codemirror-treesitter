import { describe, expect, it } from "vite-plus/test";
import { WireKind, encodeWireBatch, encodeWireMessage } from "./protocol.ts";
import {
  estimatedDecodedBase64Bytes,
  maxBinaryByteBurst,
  maxBinaryBytesPerMinute,
  maxBatchMessages,
  maxDocumentUpdateBytes,
  maxFrameBytes,
  maxHostSaveAckPayloadBytes,
  maxPresencePayloadBytes,
  maxSnapshotBytes,
  maxUpdateFrameBurst,
  maxUpdateFramesPerMinute,
  validateWireFrameLimits,
} from "./share-limits.ts";

describe("shared relay safety limits", () => {
  it("estimates decoded base64 size before allocating decoded bytes", () => {
    expect(estimatedDecodedBase64Bytes("AA==")).toBe(1);
    expect(estimatedDecodedBase64Bytes("AAA=")).toBe(2);
    expect(estimatedDecodedBase64Bytes("AAAA")).toBe(3);
    expect(estimatedDecodedBase64Bytes("A")).toBeNull();
  });

  it("accepts bounded document frames", () => {
    let frame = encodeWireMessage(WireKind.Doc, new Uint8Array(32));

    expect(
      validateWireFrameLimits(frame.byteLength, [
        { kind: WireKind.Doc, payload: new Uint8Array(32) },
      ]),
    ).toEqual({ ok: true });
  });

  it("keeps the binary byte bucket large enough for the existing document update allowance", () => {
    let maximumDocumentFrameBytes = maxDocumentUpdateBytes + 1;

    expect(maxBinaryByteBurst).toBeGreaterThanOrEqual(
      maxUpdateFrameBurst * maximumDocumentFrameBytes,
    );
    expect(maxBinaryBytesPerMinute).toBeGreaterThanOrEqual(
      maxUpdateFramesPerMinute * maximumDocumentFrameBytes,
    );
  });

  it("rejects oversized frames, batches, and payloads", () => {
    expect(validateWireFrameLimits(maxFrameBytes + 1, [])).toMatchObject({
      closeCode: 1009,
      ok: false,
    });
    expect(
      validateWireFrameLimits(
        0,
        Array.from({ length: maxBatchMessages + 1 }, () => ({
          kind: WireKind.Presence,
          payload: new Uint8Array(),
        })),
      ),
    ).toMatchObject({ closeCode: 1008, ok: false });
    expect(
      validateWireFrameLimits(0, [
        { kind: WireKind.Doc, payload: new Uint8Array(maxDocumentUpdateBytes + 1) },
      ]),
    ).toMatchObject({ closeCode: 1009, ok: false });
    expect(
      validateWireFrameLimits(0, [
        { kind: WireKind.Snapshot, payload: new Uint8Array(maxSnapshotBytes + 1) },
      ]),
    ).toMatchObject({ closeCode: 1009, ok: false });
    expect(
      validateWireFrameLimits(0, [
        { kind: WireKind.Presence, payload: new Uint8Array(maxPresencePayloadBytes + 1) },
      ]),
    ).toMatchObject({ closeCode: 1009, ok: false });
  });

  it("rejects batches whose aggregate payload exceeds the product snapshot limit", () => {
    let messages = [
      { kind: WireKind.Doc, payload: new Uint8Array(maxDocumentUpdateBytes) },
      { kind: WireKind.Doc, payload: new Uint8Array(maxDocumentUpdateBytes) },
      { kind: WireKind.Doc, payload: new Uint8Array(maxDocumentUpdateBytes) },
      { kind: WireKind.Doc, payload: new Uint8Array(maxDocumentUpdateBytes) },
      { kind: WireKind.Doc, payload: new Uint8Array(1) },
    ];
    let frame = encodeWireBatch(messages);

    expect(validateWireFrameLimits(frame.byteLength, messages)).toMatchObject({
      closeCode: 1009,
      ok: false,
    });
  });

  it("rejects host save acknowledgements larger than 16 KiB", () => {
    let payload = new Uint8Array(maxHostSaveAckPayloadBytes + 1);

    expect(
      validateWireFrameLimits(payload.byteLength + 1, [{ kind: WireKind.HostSaveAck, payload }]),
    ).toMatchObject({ closeCode: 1009, ok: false });
  });
});
