import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { VersionVector } from "loro-crdt";
import {
  getCollabDocumentValue,
  savePendingCollabDocumentUpdates,
  type CollabDocumentState,
} from "@/lib/collaboration/markdown-document";
import {
  configuredShareRelayOrigin,
  createRelayShareSession,
} from "@/lib/collaboration/share-relay-client";
import { ShareRelayConnection } from "@/lib/collaboration/share-relay-connection";
import type { OwnerShareRecord } from "@/lib/collaboration/share-storage";
import { hashMarkdownText } from "@/lib/markdown-hash";
import { errorToMessage } from "@/lib/workspace/errors";
import {
  getOrCreateOwnerShareClientId,
  mergeOwnerShareStatus,
  readHostSecret,
  serializeVersionVector,
} from "@/lib/workspace/share-host";
import type { ActiveOwnerShareRecord, SaveState } from "@/lib/workspace/types";
import type { WorkspaceBackend } from "@/lib/workspace-backend";

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

  useEffect(
    () => () => {
      shareHostUpdateCleanupRef.current();
      shareHostConnectionRef.current?.close();
    },
    [],
  );

  let sendHostSaveAck = useCallback(
    (path: string, value: string, savedVersion: VersionVector) => {
      let record = shareHostRecordRef.current;
      let connection = shareHostConnectionRef.current;
      if (!record || !connection || record.path != path) return;

      let materializedHash = hashMarkdownText(value);
      connection.enqueueHostSaveAck(
        new TextEncoder().encode(
          JSON.stringify({
            materializedHash,
            savedAt: Date.now(),
            shareId: record.shareId,
            versionVector: serializeVersionVector(savedVersion),
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

  let sendHostDocumentUpdate = useCallback((path: string, update: Uint8Array | null) => {
    if (!update?.byteLength) return;
    let record = shareHostRecordRef.current;
    let connection = shareHostConnectionRef.current;
    if (!record || !connection || record.path != path) return;
    connection.enqueueDocumentUpdate(update);
  }, []);

  let isOwnerShareHostPath = useCallback((path: string) => {
    return shareHostRecordRef.current?.path == path;
  }, []);

  let startOwnerShareHost = useCallback(
    async (
      record: OwnerShareRecord,
      backend: WorkspaceBackend,
      document: CollabDocumentState,
      options: { actionLabel?: string; shouldContinue?: () => boolean } = {},
    ) => {
      if (options.shouldContinue && !options.shouldContinue()) return;
      stopOwnerShareHost();

      let actionLabel = options.actionLabel ?? "Link created";
      let hostSecret = readHostSecret(record);
      if (!hostSecret) {
        setShareError(`${actionLabel}, but this browser cannot host it without the host key.`);
        return;
      }

      try {
        let session = await createRelayShareSession(
          configuredShareRelayOrigin(),
          record.shareId,
          "host",
          hostSecret,
        );
        if (options.shouldContinue && !options.shouldContinue()) return;
        setActiveShareRecord((current) =>
          current?.shareId == record.shareId
            ? {
                ...current,
                expiresAt: session.shareExpiresAt,
                guestCount: session.guestCount,
                hostOnline: session.hostOnline,
                peerCount: session.peerCount,
                pendingHostSave: session.pendingHostSave,
              }
            : current,
        );
        let connection = new ShareRelayConnection({
          clientId: getOrCreateOwnerShareClientId(),
          doc: document.doc,
          onDocumentImported: () => {
            editorValueRef.current = getCollabDocumentValue(document);
            editVersionRef.current += 1;
            dirtyRef.current = true;
            setSaveStateSynced("pending");
            void savePendingCollabDocumentUpdates(backend, document).catch(() => {});
            scheduleAutoSaveRef.current();
          },
          onError: (message) => setShareError(message),
          onShareStatus: (status) => {
            setActiveShareRecord((current) =>
              current?.shareId == status.shareId ? mergeOwnerShareStatus(current, status) : current,
            );
          },
          relayOrigin: configuredShareRelayOrigin(),
          sessionToken: session.sessionToken,
          shareId: record.shareId,
        });
        shareHostConnectionRef.current = connection;
        shareHostRecordRef.current = record;
        shareHostUpdateCleanupRef.current = document.doc.subscribeLocalUpdates((bytes) => {
          connection.enqueueDocumentUpdate(bytes);
        });
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
    sendHostDocumentUpdate,
    sendHostSaveAck,
    isOwnerShareHostPath,
    startOwnerShareHost,
    stopOwnerShareHost,
  };
}
