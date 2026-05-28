import { describe, expect, it } from "vite-plus/test";
import { createShortRoomId, isValidRoomId, selectRoomFromHash } from "./room.ts";

describe("collaboration room ids", () => {
  it("creates short shareable room ids", () => {
    let roomId = createShortRoomId();

    expect(roomId).toHaveLength(12);
    expect(isValidRoomId(roomId)).toBe(true);
  });

  it("keeps existing valid hash room ids, including old UUID links", () => {
    let room = selectRoomFromHash("#4f4247d4-bca4-40df-a76f-0973184c5321", () => "unused-room");

    expect(room).toEqual({
      generated: false,
      id: "4f4247d4-bca4-40df-a76f-0973184c5321",
    });
  });

  it("generates a room id when the hash is missing or invalid", () => {
    let room = selectRoomFromHash("#not valid", () => "Ab3kP9qLm2xZ");

    expect(room).toEqual({ generated: true, id: "Ab3kP9qLm2xZ" });
  });
});
