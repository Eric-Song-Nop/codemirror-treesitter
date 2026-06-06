export const WireKind = {
  Doc: 1,
  Presence: 2,
  Snapshot: 3,
  HostSaveAck: 4,
  ShareStatus: 5,
  RelayAckRequest: 6,
  RelayAck: 7,
  Batch: 9,
} as const;

export type WireKind = (typeof WireKind)[keyof typeof WireKind];

export type WireMessage = {
  kind: WireKind;
  payload: Uint8Array;
};

const headerSize = 5;

export function encodeWireMessage(kind: WireKind, payload: Uint8Array): Uint8Array {
  let frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = kind;
  frame.set(payload, 1);
  return frame;
}

export function encodeWireBatch(messages: readonly WireMessage[]): Uint8Array {
  if (messages.length == 1) {
    return encodeWireMessage(messages[0]!.kind, messages[0]!.payload);
  }

  let byteLength = 1;
  for (let message of messages) byteLength += headerSize + message.payload.byteLength;

  let frame = new Uint8Array(byteLength);
  let view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let offset = 1;
  frame[0] = WireKind.Batch;

  for (let message of messages) {
    frame[offset] = message.kind;
    view.setUint32(offset + 1, message.payload.byteLength);
    offset += headerSize;
    frame.set(message.payload, offset);
    offset += message.payload.byteLength;
  }

  return frame;
}

export function decodeWireFrame(data: ArrayBuffer | ArrayBufferView): WireMessage[] {
  let frame = toUint8Array(data);
  let kind = frame[0] as WireKind | undefined;
  if (!isWireKind(kind)) throw new Error("Unknown wire message kind");

  if (kind != WireKind.Batch) {
    return [{ kind, payload: frame.slice(1) }];
  }

  let view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let messages: WireMessage[] = [];
  let offset = 1;

  while (offset < frame.byteLength) {
    if (offset + headerSize > frame.byteLength) throw new Error("Truncated wire batch header");

    let messageKind = frame[offset] as WireKind | undefined;
    if (!isWireKind(messageKind) || messageKind == WireKind.Batch) {
      throw new Error("Invalid wire batch message kind");
    }

    let payloadLength = view.getUint32(offset + 1);
    offset += headerSize;

    if (offset + payloadLength > frame.byteLength) throw new Error("Truncated wire batch payload");

    messages.push({
      kind: messageKind,
      payload: frame.slice(offset, offset + payloadLength),
    });
    offset += payloadLength;
  }

  return messages;
}

export function toUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function isWireKind(kind: number | undefined): kind is WireKind {
  return (
    kind == WireKind.Doc ||
    kind == WireKind.Presence ||
    kind == WireKind.Snapshot ||
    kind == WireKind.HostSaveAck ||
    kind == WireKind.ShareStatus ||
    kind == WireKind.RelayAckRequest ||
    kind == WireKind.RelayAck ||
    kind == WireKind.Batch
  );
}
