import { useCallback, useMemo, useState } from "react";
import type { CreatedOwnerShare } from "@/lib/collaboration/share-storage";
import type { ShareExpirationOption } from "@/lib/collaboration/share-identity";
import type { ActiveOwnerShareRecord, SingleFileSource } from "@/lib/workspace/types";
import type { MarkdownFileNode } from "@/lib/workspace-backend";

type UseWorkspaceShareStateOptions = {
  selectedFile: MarkdownFileNode | null;
  singleFileSource: SingleFileSource | null;
};

export function useWorkspaceShareState({
  selectedFile,
  singleFileSource,
}: UseWorkspaceShareStateOptions) {
  let [shareDialogOpen, setShareDialogOpen] = useState(false);
  let [shareExpiration, setShareExpiration] = useState<ShareExpirationOption>("7d");
  let [shareError, setShareError] = useState("");
  let [shareCreating, setShareCreating] = useState(false);
  let [shareCopied, setShareCopied] = useState(false);
  let [createdShare, setCreatedShare] = useState<CreatedOwnerShare | null>(null);
  let [activeShareRecord, setActiveShareRecord] = useState<ActiveOwnerShareRecord | null>(null);

  let activeShareForSelectedFile = useMemo(
    () =>
      !singleFileSource &&
      activeShareRecord &&
      activeShareRecord.path == selectedFile?.path &&
      activeShareRecord.revokedAt == null
        ? activeShareRecord
        : null,
    [activeShareRecord, selectedFile?.path, singleFileSource],
  );

  let openShareDialog = useCallback(() => {
    setShareDialogOpen(true);
    setShareError("");
    setShareCopied(false);
    setCreatedShare(null);
    setShareExpiration("7d");
  }, []);

  let closeShareDialog = useCallback((open: boolean) => {
    setShareDialogOpen(open);
    if (!open) {
      setShareError("");
      setShareCopied(false);
    }
  }, []);

  let copySharedFileLink = useCallback(async () => {
    if (!createdShare) return;

    try {
      await navigator.clipboard.writeText(createdShare.link);
      setShareCopied(true);
      setShareError("");
    } catch {
      setShareCopied(false);
      setShareError("Could not copy the link.");
    }
  }, [createdShare]);

  return {
    activeShareForSelectedFile,
    activeShareRecord,
    closeShareDialog,
    copySharedFileLink,
    createdShare,
    openShareDialog,
    setActiveShareRecord,
    setCreatedShare,
    setShareCopied,
    setShareCreating,
    setShareError,
    setShareExpiration,
    shareCopied,
    shareCreating,
    shareDialogOpen,
    shareError,
    shareExpiration,
  };
}
