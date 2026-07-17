import { useEffect, useRef, useState } from "react";
import type { LoroDoc, VersionVector } from "loro-crdt";
import {
  ShareRelayConnection,
  type ShareRelayConnectionState,
  type ShareRelayStatus,
} from "@/lib/collaboration/share-relay-connection";
import type { RelayShareSession } from "@/lib/collaboration/share-relay-client";
import type { SerializedCollabVersionVector } from "@/lib/collaboration/collab-browser-store";

type UseSharedFileConnectionOptions = {
  canConnect: boolean;
  disabledErrorMessage: string;
  doc: LoroDoc;
  joining: boolean;
  relayOrigin: string;
  refreshSession: (signal: AbortSignal) => Promise<RelayShareSession>;
  session: RelayShareSession | null;
  sessionErrorMessage: string;
  sessionKey: string;
  shareId: string;
};

const defaultSharedFileDisplayName = "Shared file";

export function useSharedFileConnection({
  canConnect,
  disabledErrorMessage,
  doc,
  joining,
  relayOrigin,
  refreshSession,
  session,
  sessionErrorMessage,
  sessionKey,
  shareId,
}: UseSharedFileConnectionOptions) {
  let [sessionReady, setSessionReady] = useState(false);
  let [displayName, setDisplayName] = useState(defaultSharedFileDisplayName);
  let [connectionState, setConnectionState] = useState<ShareRelayConnectionState>("connecting");
  let [shareStatus, setShareStatus] = useState<ShareRelayStatus | null>(null);
  let [latestLocalVersion, setLatestLocalVersion] = useState<SerializedCollabVersionVector | null>(
    null,
  );
  let [hostSavedVersion, setHostSavedVersion] = useState<SerializedCollabVersionVector | null>(
    null,
  );
  let [lastHostSavedAt, setLastHostSavedAt] = useState<number | null>(null);
  let [errorMessage, setErrorMessage] = useState("");
  let connectionRef = useRef<ShareRelayConnection | null>(null);
  let refreshSessionRef = useRef(refreshSession);
  refreshSessionRef.current = refreshSession;

  useEffect(
    () =>
      doc.subscribeLocalUpdates((bytes) => {
        connectionRef.current?.enqueueDocumentUpdate(bytes);
        setLatestLocalVersion(serializeDocVersion(doc));
      }),
    [doc],
  );

  useEffect(() => {
    setDisplayName(defaultSharedFileDisplayName);
    setShareStatus(null);
    setSessionReady(false);
    setLatestLocalVersion(null);
    setHostSavedVersion(null);
    setLastHostSavedAt(null);

    if (disabledErrorMessage) {
      setConnectionState("offline");
      setErrorMessage(disabledErrorMessage);
      return;
    }

    setErrorMessage("");
  }, [disabledErrorMessage, relayOrigin, sessionKey, shareId]);

  useEffect(() => {
    if (!canConnect || !joining || sessionReady) return;

    setConnectionState("connecting");
    setSessionReady(false);
    setDisplayName(defaultSharedFileDisplayName);
    setShareStatus(null);
    setLatestLocalVersion(null);
    setHostSavedVersion(null);
    setLastHostSavedAt(null);
  }, [canConnect, joining, sessionReady]);

  useEffect(() => {
    if (!sessionErrorMessage) return;
    setConnectionState("offline");
    setErrorMessage(sessionErrorMessage);
    setSessionReady(false);
  }, [sessionErrorMessage]);

  useEffect(() => {
    if (!canConnect || !session) return;

    setErrorMessage("");
    setDisplayName(session.displayName);
    setShareStatus({
      displayName: session.displayName,
      expiresAt: session.shareExpiresAt,
      guestCount: session.guestCount,
      hostOnline: session.hostOnline,
      peerCount: session.peerCount,
      pendingHostSave: session.pendingHostSave,
      revokedAt: null,
      shareId: session.shareId,
    });

    let connection = new ShareRelayConnection({
      clientId: getOrCreateSharedFileClientId(),
      doc,
      onConnectionState: setConnectionState,
      onDocumentImported: () => {
        setLatestLocalVersion(serializeDocVersion(doc));
      },
      onError: setErrorMessage,
      onHostSaveAck: (payload) => {
        let ack = parseHostSaveAck(payload);
        if (!ack || ack.shareId != shareId) return;
        setLastHostSavedAt(ack.savedAt);
        setHostSavedVersion(ack.versionVector);
      },
      onShareStatus: (status) => {
        setShareStatus(status);
        if (status.displayName) setDisplayName(status.displayName);
      },
      refreshSessionToken: async (signal) => {
        let refreshed = await refreshSessionRef.current(signal);
        signal.throwIfAborted();
        setErrorMessage("");
        return refreshed.sessionToken;
      },
      relayOrigin,
      sessionToken: session.sessionToken,
      shareId,
    });
    connectionRef.current = connection;
    connection.connect();
    setSessionReady(true);

    return () => {
      if (connectionRef.current == connection) connectionRef.current = null;
      connection.close();
    };
  }, [canConnect, doc, relayOrigin, session, shareId]);

  useEffect(() => {
    let handleOnline = () => connectionRef.current?.connect();
    let handleOffline = () => connectionRef.current?.pause();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return {
    connectionState,
    displayName,
    errorMessage,
    hostSavedVersion,
    lastHostSavedAt,
    latestLocalVersion,
    reconnect: () => connectionRef.current?.connect(),
    sessionReady,
    shareStatus,
  };
}

function parseHostSaveAck(payload: Uint8Array) {
  try {
    let value = JSON.parse(new TextDecoder().decode(payload)) as {
      savedAt?: unknown;
      shareId?: unknown;
      versionVector?: unknown;
    };
    if (typeof value.savedAt != "number" || typeof value.shareId != "string") return null;
    let versionVector = parseVersionVector(value.versionVector);
    if (!versionVector) return null;
    return {
      savedAt: value.savedAt,
      shareId: value.shareId,
      versionVector,
    };
  } catch {
    return null;
  }
}

function parseVersionVector(value: unknown) {
  if (!Array.isArray(value)) return null;
  let version: SerializedCollabVersionVector = [];
  for (let entry of value) {
    if (!Array.isArray(entry) || entry.length != 2) return null;
    let [peer, counter] = entry;
    if (
      typeof peer != "string" ||
      !/^\d+$/.test(peer) ||
      typeof counter != "number" ||
      !Number.isSafeInteger(counter) ||
      counter < 0
    ) {
      return null;
    }
    version.push([peer as `${number}`, counter]);
  }
  return version;
}

function serializeDocVersion(doc: LoroDoc) {
  let version = doc.oplogVersion();
  try {
    return serializeVersionVector(version);
  } finally {
    version.free();
  }
}

function serializeVersionVector(version: VersionVector): SerializedCollabVersionVector {
  return [...version.toJSON()].map(([peer, counter]) => [String(peer) as `${number}`, counter]);
}

function getOrCreateSharedFileClientId() {
  try {
    let existing = sessionStorage.getItem("local-md-workspace:shared-file-client-id");
    if (existing) return existing;
    let next = crypto.randomUUID();
    sessionStorage.setItem("local-md-workspace:shared-file-client-id", next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}
