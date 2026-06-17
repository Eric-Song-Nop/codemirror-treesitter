import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import {
  createOwnerShare,
  revokeOwnerShare,
  rotateOwnerShare,
  type CreatedOwnerShare,
  type OwnerShareRecord,
} from "@/lib/collaboration/share-storage";
import { configuredShareRelayOrigin } from "@/lib/collaboration/share-relay-client";
import type { ShareExpirationOption } from "@/lib/collaboration/share-identity";
import { errorToMessage } from "@/lib/workspace/errors";
import { readHostSecret } from "@/lib/workspace/share-host";
import type { ActiveOwnerShareRecord } from "@/lib/workspace/types";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";

type MutableRef<T> = {
  current: T;
};

type StartOwnerShareHost = (
  record: OwnerShareRecord,
  backend: WorkspaceBackend,
  document: CollabDocumentState,
  options?: { actionLabel?: string; shouldContinue?: () => boolean },
) => Promise<void>;

type UseWorkspaceShareActionsOptions = {
  activeShareRecord: ActiveOwnerShareRecord | null;
  collabDocumentRef: MutableRef<CollabDocumentState | null>;
  ensureSelectedCollabDocument: (
    backend: WorkspaceBackend,
    file: MarkdownFileNode,
  ) => Promise<CollabDocumentState>;
  flushOwnerShareHost: () => void;
  saveCurrentFile: () => Promise<boolean>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  setActiveShareRecord: Dispatch<SetStateAction<ActiveOwnerShareRecord | null>>;
  setCreatedShare: Dispatch<SetStateAction<CreatedOwnerShare | null>>;
  setShareCopied: (copied: boolean) => void;
  setShareCreating: (creating: boolean) => void;
  setShareError: (message: string) => void;
  shareExpiration: ShareExpirationOption;
  startOwnerShareHost: StartOwnerShareHost;
  stopOwnerShareHost: () => void;
  workspaceBackendRef: MutableRef<WorkspaceBackend | null>;
};

export function useWorkspaceShareActions({
  activeShareRecord,
  collabDocumentRef,
  ensureSelectedCollabDocument,
  flushOwnerShareHost,
  saveCurrentFile,
  selectedFileRef,
  setActiveShareRecord,
  setCreatedShare,
  setShareCopied,
  setShareCreating,
  setShareError,
  shareExpiration,
  startOwnerShareHost,
  stopOwnerShareHost,
  workspaceBackendRef,
}: UseWorkspaceShareActionsOptions) {
  let createSharedFileLink = useCallback(async () => {
    let backend = workspaceBackendRef.current;
    let file = selectedFileRef.current;
    if (!backend || !file) return;
    if (!(await saveCurrentFile())) return;

    setShareCreating(true);
    setShareError("");
    setShareCopied(false);
    try {
      let document = await ensureSelectedCollabDocument(backend, file);
      let share = await createOwnerShare({
        backend,
        baseUrl: window.location.href,
        document,
        expiration: shareExpiration,
        file,
        relayOrigin: configuredShareRelayOrigin(),
      });
      setCreatedShare(share);
      setActiveShareRecord(share.record);
      await startOwnerShareHost(share.record, backend, document);
    } catch (error) {
      setShareError(errorToMessage(error));
    } finally {
      setShareCreating(false);
    }
  }, [
    ensureSelectedCollabDocument,
    saveCurrentFile,
    selectedFileRef,
    setActiveShareRecord,
    setCreatedShare,
    setShareCopied,
    setShareCreating,
    setShareError,
    shareExpiration,
    startOwnerShareHost,
    workspaceBackendRef,
  ]);

  let rotateSharedFileLink = useCallback(async () => {
    let backend = workspaceBackendRef.current;
    let record = activeShareRecord;
    if (!backend || !record || record.revokedAt != null) return;

    let document = collabDocumentRef.current;
    let shouldRestartHost = document?.path == record.path;
    let hostSecret = readHostSecret(record);
    if (!hostSecret) {
      setShareError("This browser cannot rotate the link without the host key.");
      return;
    }

    setShareCreating(true);
    setShareError("");
    setShareCopied(false);
    if (shouldRestartHost) stopOwnerShareHost();
    try {
      let share = await rotateOwnerShare({
        backend,
        baseUrl: window.location.href,
        expiration: shareExpiration,
        hostSecret,
        record,
        relayOrigin: configuredShareRelayOrigin(),
      });
      setCreatedShare(share);
      setActiveShareRecord(share.record);
      if (shouldRestartHost && document) {
        await startOwnerShareHost(share.record, backend, document, {
          actionLabel: "Link rotated",
        });
      }
    } catch (error) {
      setShareError(errorToMessage(error));
      if (shouldRestartHost && document) {
        void startOwnerShareHost(record, backend, document, {
          actionLabel: "Link rotation failed",
        });
      }
    } finally {
      setShareCreating(false);
    }
  }, [
    activeShareRecord,
    collabDocumentRef,
    setActiveShareRecord,
    setCreatedShare,
    setShareCopied,
    setShareCreating,
    setShareError,
    shareExpiration,
    startOwnerShareHost,
    stopOwnerShareHost,
    workspaceBackendRef,
  ]);

  let stopSharingFile = useCallback(async () => {
    let backend = workspaceBackendRef.current;
    let record = activeShareRecord;
    if (!backend || !record || record.revokedAt != null) return;

    let hostSecret = readHostSecret(record);
    if (!hostSecret) {
      setShareError("This browser cannot stop sharing without the host key.");
      return;
    }

    setShareCreating(true);
    setShareError("");
    setShareCopied(false);
    try {
      flushOwnerShareHost();
      let nextRecord = await revokeOwnerShare({
        backend,
        hostSecret,
        record,
        relayOrigin: configuredShareRelayOrigin(),
      });
      stopOwnerShareHost();
      setActiveShareRecord(nextRecord);
      setCreatedShare(null);
    } catch (error) {
      setShareError(errorToMessage(error));
    } finally {
      setShareCreating(false);
    }
  }, [
    activeShareRecord,
    flushOwnerShareHost,
    setActiveShareRecord,
    setCreatedShare,
    setShareCopied,
    setShareCreating,
    setShareError,
    stopOwnerShareHost,
    workspaceBackendRef,
  ]);

  return {
    createSharedFileLink,
    rotateSharedFileLink,
    stopSharingFile,
  };
}
