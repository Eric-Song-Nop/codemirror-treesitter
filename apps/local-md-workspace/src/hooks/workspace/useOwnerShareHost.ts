import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { SerializedCollabVersionVector } from "@/lib/collaboration/collab-browser-store";
import {
  getCollabDocumentValue,
  scheduleCollabDocumentSnapshotFlush,
} from "@/lib/collaboration/markdown-document";
import {
  configuredShareRelayOrigin,
  createRelayShareSession,
} from "@/lib/collaboration/share-relay-client";
import type { ShareRelayConnection } from "@/lib/collaboration/share-relay-connection";
import type { OwnerShareRecord } from "@/lib/collaboration/share-storage";
import { hashMarkdownText } from "@/lib/collaboration/markdown-hash";
import { errorToMessage } from "@/lib/workspace/errors";
import {
  getOrCreateOwnerShareClientId,
  mergeOwnerShareStatus,
  readHostSecret,
} from "@/lib/workspace/share-host";
import type { ActiveOwnerShareRecord, SaveState } from "@/lib/workspace/types";
import type { DocumentSession } from "@/lib/workspace/document-session";
import { documentSourceRef, sameDocumentSourceRef } from "@/lib/workspace/source-identity";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

type MutableRef<T> = {
  current: T;
};

type UseOwnerShareHostOptions = {
  dirtyRef: MutableRef<boolean>;
  editorValueRef: MutableRef<string>;
  editVersionRef: MutableRef<number>;
  scheduleAutoSaveRef: MutableRef<() => void>;
  setActiveShareRecord: Dispatch<SetStateAction<ActiveOwnerShareRecord | null>>;
  setSaveStateSynced: (state: SaveState) => void;
  setShareError: (message: string) => void;
};

export function useOwnerShareHost({
  dirtyRef,
  editorValueRef,
  editVersionRef,
  scheduleAutoSaveRef,
  setActiveShareRecord,
  setSaveStateSynced,
  setShareError,
}: UseOwnerShareHostOptions) {
  let shareHostConnectionRef = useRef<ShareRelayConnection | null>(null);
  let shareHostRecordRef = useRef<OwnerShareRecord | null>(null);
  let shareHostUpdateCleanupRef = useRef<() => void>(() => {});

  let stopOwnerShareHost = useCallback(() => {
    shareHostUpdateCleanupRef.current();
    shareHostUpdateCleanupRef.current = () => {};
    shareHostConnectionRef.current?.close();
    shareHostConnectionRef.current = null;
    shareHostRecordRef.current = null;
  }, []);

  let flushOwnerShareHost = useCallback(() => {
    shareHostConnectionRef.current?.flushNow();
  }, []);

  useEffect(
    () => () => {
      shareHostUpdateCleanupRef.current();
      shareHostConnectionRef.current?.close();
    },
    [],
  );

  let sendHostSaveAck = useCallback(
    (
      runtime: WorkspaceRuntime,
      path: string,
      value: string,
      savedVersion: SerializedCollabVersionVector,
    ) => {
      let record = shareHostRecordRef.current;
      let connection = shareHostConnectionRef.current;
      if (!record || !connection || !isOwnerShareSource(record, runtime, path)) return;

      let materializedHash = hashMarkdownText(value);
      connection.enqueueHostSaveAck(
        new TextEncoder().encode(
          JSON.stringify({
            materializedHash,
            savedAt: Date.now(),
            shareId: record.shareId,
            versionVector: savedVersion,
          }),
        ),
      );
      setActiveShareRecord((current) =>
        current?.shareId == record.shareId
          ? { ...current, lastHostSavedVersion: materializedHash }
          : current,
      );
    },
    [setActiveShareRecord],
  );

  let sendHostDocumentUpdate = useCallback(
    (runtime: WorkspaceRuntime, path: string, update: Uint8Array | null) => {
      if (!update?.byteLength) return;
      let record = shareHostRecordRef.current;
      let connection = shareHostConnectionRef.current;
      if (!record || !connection || !isOwnerShareSource(record, runtime, path)) return;
      connection.enqueueDocumentUpdate(update);
    },
    [],
  );

  let startOwnerShareHost = useCallback(
    async (
      record: OwnerShareRecord,
      session: DocumentSession,
      options: { actionLabel?: string; shouldContinue?: () => boolean } = {},
    ) => {
      if (options.shouldContinue && !options.shouldContinue()) return;
      stopOwnerShareHost();

      let actionLabel = options.actionLabel ?? "Link created";
      if (!sameDocumentSourceRef(record.sourceRef, session.sourceRef)) {
        setShareError(`${actionLabel}, but this file is no longer the shared source.`);
        return;
      }
      let hostSecret = readHostSecret(record);
      if (!hostSecret) {
        setShareError(`${actionLabel}, but this browser cannot host it without the host key.`);
        return;
      }

      try {
        let relaySession = await createRelayShareSession(
          configuredShareRelayOrigin(),
          record.shareId,
          "host",
          hostSecret,
        );
        if (options.shouldContinue && !options.shouldContinue()) return;
        let { ShareRelayConnection } = await import("@/lib/collaboration/share-relay-connection");
        if (options.shouldContinue && !options.shouldContinue()) return;
        setActiveShareRecord((current) =>
          current?.shareId == record.shareId
            ? {
                ...current,
                expiresAt: relaySession.shareExpiresAt,
                guestCount: relaySession.guestCount,
                hostOnline: relaySession.hostOnline,
                peerCount: relaySession.peerCount,
                pendingHostSave: relaySession.pendingHostSave,
              }
            : current,
        );
        let connection = new ShareRelayConnection({
          clientId: getOrCreateOwnerShareClientId(),
          doc: session.collabDocument.doc,
          onDocumentImported: () => {
            editorValueRef.current = getCollabDocumentValue(session.collabDocument);
            editVersionRef.current += 1;
            dirtyRef.current = true;
            setSaveStateSynced("pending");
            scheduleCollabDocumentSnapshotFlush(session.collabDocument);
            scheduleAutoSaveRef.current();
          },
          onError: (message) => setShareError(message),
          onShareStatus: (status) => {
            setActiveShareRecord((current) =>
              current?.shareId == status.shareId ? mergeOwnerShareStatus(current, status) : current,
            );
          },
          refreshSessionToken: async (signal) => {
            let fetchWithAbort: typeof fetch = (input, init) => fetch(input, { ...init, signal });
            let refreshed = await createRelayShareSession(
              configuredShareRelayOrigin(),
              record.shareId,
              "host",
              hostSecret,
              fetchWithAbort,
            );
            signal.throwIfAborted();
            if (shareHostConnectionRef.current != connection) {
              throw new DOMException("Owner share host changed.", "AbortError");
            }
            setShareError("");
            return refreshed.sessionToken;
          },
          relayOrigin: configuredShareRelayOrigin(),
          sessionToken: relaySession.sessionToken,
          shareId: record.shareId,
        });
        shareHostConnectionRef.current = connection;
        shareHostRecordRef.current = record;
        shareHostUpdateCleanupRef.current = session.collabDocument.doc.subscribeLocalUpdates(
          (bytes) => {
            connection.enqueueDocumentUpdate(bytes);
          },
        );
        connection.connect();
      } catch (error) {
        if (options.shouldContinue && !options.shouldContinue()) return;
        setShareError(`${actionLabel}, but host sync did not start: ${errorToMessage(error)}`);
      }
    },
    [
      dirtyRef,
      editorValueRef,
      editVersionRef,
      scheduleAutoSaveRef,
      setActiveShareRecord,
      setSaveStateSynced,
      setShareError,
      stopOwnerShareHost,
    ],
  );

  return {
    flushOwnerShareHost,
    sendHostDocumentUpdate,
    sendHostSaveAck,
    startOwnerShareHost,
    stopOwnerShareHost,
  };
}

function isOwnerShareSource(record: OwnerShareRecord, runtime: WorkspaceRuntime, path: string) {
  return sameDocumentSourceRef(record.sourceRef, documentSourceRef(runtime.identity, path));
}
