import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  hashShareSecret,
  isShareActive,
  isShareCleanupDue,
  parseCreateShareRequest,
  parseCreateSessionRequest,
  parseRevokeShareRequest,
  parseRotateShareRequest,
  shareCleanupDueAt,
  timingSafeEqualString,
  type ShareRecord,
} from "./share.ts";
import { maxShareTtlMs, maxSnapshotBytes } from "./share-limits.ts";

const validShareId = "AAAAAAAAAAAAAAAAAAAAAA";
const validSecret = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const validHash = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

describe("shared file relay inputs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses a valid create-share request", () => {
    expect(
      parseCreateShareRequest({
        displayName: " note.md ",
        expiresAt: Date.now() + 10_000,
        guestSecretHash: validHash,
        hostSecretHash: validHash,
        shareId: validShareId,
        snapshot: "AA==",
      }),
    ).toEqual({
      displayName: "note.md",
      expiresAt: expect.any(Number),
      guestSecretHash: validHash,
      hostSecretHash: validHash,
      shareId: validShareId,
      snapshot: "AA==",
    });
  });

  it("rejects malformed share requests and expired links", () => {
    expect(
      parseCreateShareRequest({
        displayName: "note.md",
        expiresAt: Date.now() - 1,
        guestSecretHash: validHash,
        hostSecretHash: validHash,
        shareId: validShareId,
        snapshot: "AA==",
      }),
    ).toBeNull();
    expect(parseCreateShareRequest({ shareId: "path-derived" })).toBeNull();
  });

  it("rejects shares without a bounded lifetime or with oversized snapshots", () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    expect(
      parseCreateShareRequest({
        ...validCreateShareRequest(),
        expiresAt: null,
      }),
    ).toBeNull();
    expect(
      parseCreateShareRequest({
        ...validCreateShareRequest(),
        expiresAt: now + maxShareTtlMs + 1,
      }),
    ).toBeNull();
    expect(
      parseCreateShareRequest({
        ...validCreateShareRequest(),
        snapshot: "A".repeat(Math.ceil(((maxSnapshotBytes + 1) * 4) / 3)),
      }),
    ).toBeNull();
  });

  it("requires rotated links to keep a bounded lifetime", () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    expect(
      parseRotateShareRequest({
        expiresAt: null,
        hostSecret: validSecret,
        nextGuestSecretHash: validHash,
      }),
    ).toBeNull();
    expect(
      parseRotateShareRequest({
        expiresAt: now + maxShareTtlMs + 1,
        hostSecret: validSecret,
        nextGuestSecretHash: validHash,
      }),
    ).toBeNull();
  });

  it("parses session, rotate, and revoke requests", () => {
    expect(parseCreateSessionRequest({ role: "guest", secret: validSecret })).toEqual({
      role: "guest",
      secret: validSecret,
    });
    expect(parseCreateSessionRequest({ role: "owner", secret: validSecret })).toBeNull();
    expect(
      parseRotateShareRequest({
        expiresAt: Date.now() + 10_000,
        hostSecret: validSecret,
        nextGuestSecretHash: validHash,
      }),
    ).toEqual({
      expiresAt: expect.any(Number),
      hostSecret: validSecret,
      nextGuestSecretHash: validHash,
    });
    expect(parseRevokeShareRequest({ hostSecret: validSecret })).toEqual({
      hostSecret: validSecret,
    });
  });

  it("detects active shares", () => {
    let record = shareRecord({ expiresAt: Date.now() + 1000 });

    expect(isShareActive(record)).toBe(true);
    expect(isShareActive({ ...record, expiresAt: Date.now() - 1000 })).toBe(false);
    expect(isShareActive({ ...record, revokedAt: Date.now() })).toBe(false);
    expect(isShareActive({ ...record, expiresAt: null })).toBe(true);
  });

  it("computes cleanup retention from expiration or revocation", () => {
    let now = 1_000_000;
    let retentionMs = 10_000;

    expect(shareCleanupDueAt(shareRecord({ expiresAt: null }), retentionMs)).toBeNull();
    expect(shareCleanupDueAt(shareRecord({ expiresAt: now + 5_000 }), retentionMs)).toBe(
      now + 15_000,
    );
    expect(
      shareCleanupDueAt(shareRecord({ expiresAt: null, revokedAt: now + 2_000 }), retentionMs),
    ).toBe(now + 12_000);
    expect(
      shareCleanupDueAt(
        shareRecord({ expiresAt: now + 5_000, revokedAt: now + 2_000 }),
        retentionMs,
      ),
    ).toBe(now + 12_000);
  });

  it("detects when a retained share is ready to clean up", () => {
    let now = 1_000_000;
    let retentionMs = 10_000;
    let record = shareRecord({ expiresAt: now - 1_000 });

    expect(isShareCleanupDue(record, now + 8_999, retentionMs)).toBe(false);
    expect(isShareCleanupDue(record, now + 9_000, retentionMs)).toBe(true);
  });

  it("hashes and compares secrets without returning the raw capability", async () => {
    let hash = await hashShareSecret(validSecret);

    expect(hash).toHaveLength(43);
    expect(hash).not.toBe(validSecret);
    expect(timingSafeEqualString(hash, hash)).toBe(true);
    expect(timingSafeEqualString(hash, validHash)).toBe(false);
  });
});

function shareRecord(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    createdAt: Date.now(),
    displayName: "note.md",
    expiresAt: null,
    guestSecretHash: validHash,
    hostSecretHash: validHash,
    schemaVersion: 1,
    shareId: validShareId,
    ...overrides,
  };
}

function validCreateShareRequest() {
  return {
    displayName: "note.md",
    expiresAt: Date.now() + 10_000,
    guestSecretHash: validHash,
    hostSecretHash: validHash,
    shareId: validShareId,
    snapshot: "AA==",
  };
}
