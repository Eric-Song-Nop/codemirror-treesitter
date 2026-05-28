export type RoomSelection = {
  generated: boolean;
  id: string;
};

const roomIdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const shortRoomIdLength = 12;
const validRoomIdPattern = /^[A-Za-z0-9_-]{8,96}$/;

export function createShortRoomId() {
  let bytes = crypto.getRandomValues(new Uint8Array(shortRoomIdLength));
  let id = "";

  for (let byte of bytes) {
    id += roomIdAlphabet[byte & 63];
  }

  return id;
}

export function isValidRoomId(value: string) {
  return validRoomIdPattern.test(value);
}

export function selectRoomFromHash(hash: string, createRoomId = createShortRoomId): RoomSelection {
  let id = decodeURIComponent(hash.replace(/^#/, ""));
  if (isValidRoomId(id)) return { generated: false, id };
  return { generated: true, id: createRoomId() };
}
