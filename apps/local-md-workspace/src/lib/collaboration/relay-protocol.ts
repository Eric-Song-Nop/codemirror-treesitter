export const RelayWireKind = {
  Doc: 1,
  Presence: 2,
  Snapshot: 3,
  HostSaveAck: 4,
  ShareStatus: 5,
  RelayAckRequest: 6,
  RelayAck: 7,
  Batch: 9,
} as const;

export type RelayWireKind = (typeof RelayWireKind)[keyof typeof RelayWireKind];

export type RelayWireMessage = {
  kind: RelayWireKind;
  payload: Uint8Array;
};

const headerSize = 5;

export function encodeRelayWireMessage(kind: RelayWireKind, payload: Uint8Array) {
  let frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = kind;
  frame.set(payload, 1);
  return frame;
}

export function encodeRelayWireBatch(messages: readonly RelayWireMessage[]) {
  if (messages.length == 1) {
    return encodeRelayWireMessage(messages[0]!.kind, messages[0]!.payload);
  }

  let byteLength = 1;
  for (let message of messages) byteLength += headerSize + message.payload.byteLength;

  let frame = new Uint8Array(byteLength);
  let view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let offset = 1;
  frame[0] = RelayWireKind.Batch;

  for (let message of messages) {
    frame[offset] = message.kind;
    view.setUint32(offset + 1, message.payload.byteLength);
    offset += headerSize;
    frame.set(message.payload, offset);
    offset += message.payload.byteLength;
  }

  return frame;
}

export function decodeRelayWireFrame(data: ArrayBuffer | ArrayBufferView) {
  let frame = toUint8Array(data);
  let kind = frame[0] as RelayWireKind | undefined;
  if (!isRelayWireKind(kind)) throw new Error("Unknown relay wire message kind.");

  if (kind != RelayWireKind.Batch) {
    return [{ kind, payload: frame.slice(1) }];
  }

  let view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let messages: RelayWireMessage[] = [];
  let offset = 1;

  while (offset < frame.byteLength) {
    if (offset + headerSize > frame.byteLength) throw new Error("Truncated relay batch header.");

    let messageKind = frame[offset] as RelayWireKind | undefined;
    if (!isRelayWireKind(messageKind) || messageKind == RelayWireKind.Batch) {
      throw new Error("Invalid relay batch message kind.");
    }

    let payloadLength = view.getUint32(offset + 1);
    offset += headerSize;

    if (offset + payloadLength > frame.byteLength) {
      throw new Error("Truncated relay batch payload.");
    }

    messages.push({
      kind: messageKind,
      payload: frame.slice(offset, offset + payloadLength),
    });
    offset += payloadLength;
  }

  return messages;
}

export function toUint8Array(data: ArrayBuffer | ArrayBufferView) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function isRelayWireKind(kind: number | undefined): kind is RelayWireKind {
  return (
    kind == RelayWireKind.Doc ||
    kind == RelayWireKind.Presence ||
    kind == RelayWireKind.Snapshot ||
    kind == RelayWireKind.HostSaveAck ||
    kind == RelayWireKind.ShareStatus ||
    kind == RelayWireKind.RelayAckRequest ||
    kind == RelayWireKind.RelayAck ||
    kind == RelayWireKind.Batch
  );
}
