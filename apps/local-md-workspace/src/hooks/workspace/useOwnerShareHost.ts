import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
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
import type { ActiveOwnerShareRecord } from "@/lib/workspace/types";
import type { WorkspaceDocumentContext } from "@/lib/workspace/document-context";
import { sameDocumentSourceRef } from "@/lib/workspace/source-identity";

type UseOwnerShareHostOptions = {
  setActiveShareRecord: Dispatch<SetStateAction<ActiveOwnerShareRecord | null>>;
  setShareError: (message: string) => void;
};

export function useOwnerShareHost({
  setActiveShareRecord,
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

  let startOwnerShareHost = useCallback(
    async (
      record: OwnerShareRecord,
      context: WorkspaceDocumentContext,
      options: { actionLabel?: string; shouldContinue?: () => boolean } = {},
    ) => {
      if (options.shouldContinue && !options.shouldContinue()) return;
      stopOwnerShareHost();

      let actionLabel = options.actionLabel ?? "Link created";
      if (!sameDocumentSourceRef(record.sourceRef, context.sourceRef)) {
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
          doc: context.collabDocument.loroDoc,
          onDocumentImported: () => {},
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
        let stopLocalUpdates = context.collabDocument.loroDoc.subscribeLocalUpdates((bytes) => {
          connection.enqueueDocumentUpdate(bytes);
        });
        let stopDocumentEvents = context.collabDocument.subscribe((event) => {
          if (event.kind == "closed") {
            if (shareHostConnectionRef.current == connection) stopOwnerShareHost();
            return;
          }
          if (event.kind != "materialized") return;
          if (event.sourceUpdate?.byteLength) connection.enqueueDocumentUpdate(event.sourceUpdate);

          let materializedHash = hashMarkdownText(event.materialization.value);
          connection.enqueueHostSaveAck(
            new TextEncoder().encode(
              JSON.stringify({
                materializedHash,
                savedAt: Date.now(),
                shareId: record.shareId,
                versionVector: event.materialization.versionVector,
              }),
            ),
          );
          setActiveShareRecord((current) =>
            current?.shareId == record.shareId
              ? { ...current, lastHostSavedVersion: materializedHash }
              : current,
          );
        });
        shareHostUpdateCleanupRef.current = () => {
          stopLocalUpdates();
          stopDocumentEvents();
        };
        connection.connect();
      } catch (error) {
        if (options.shouldContinue && !options.shouldContinue()) return;
        setShareError(`${actionLabel}, but host sync did not start: ${errorToMessage(error)}`);
      }
    },
    [setActiveShareRecord, setShareError, stopOwnerShareHost],
  );

  return {
    flushOwnerShareHost,
    startOwnerShareHost,
    stopOwnerShareHost,
  };
}
