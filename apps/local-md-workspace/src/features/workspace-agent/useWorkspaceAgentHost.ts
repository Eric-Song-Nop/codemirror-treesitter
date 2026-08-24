import { useCallback } from "react";
import {
  createWorkspaceAgentRunHost,
  type CreateWorkspaceAgentRunHost,
  type WorkspaceAgentHostRefs,
} from "@/lib/agent/adapters/workspace/run-host";

export type { CreateWorkspaceAgentRunHost, WorkspaceAgentHostRefs };

/**
 * Returns a stable factory. Calling it starts a new workspace-bound Agent run.
 * The refs stay live so an identity switch disables writes without treating
 * ordinary document edits as a switch.
 */
export function useWorkspaceAgentHost(input: WorkspaceAgentHostRefs): CreateWorkspaceAgentRunHost {
  let {
    activeDocumentGenerationRef,
    collabDocumentRef,
    dirtyRef,
    documentTargetGenerationRef,
    editorElementRef,
    editVersionRef,
    selectedFileSourceRef,
    selectedFileRef,
    singleFileSourceRef,
    workspaceRuntimeRef,
  } = input;

  return useCallback(
    () =>
      createWorkspaceAgentRunHost({
        activeDocumentGenerationRef,
        collabDocumentRef,
        dirtyRef,
        documentTargetGenerationRef,
        editorElementRef,
        editVersionRef,
        selectedFileSourceRef,
        selectedFileRef,
        singleFileSourceRef,
        workspaceRuntimeRef,
      }),
    [
      activeDocumentGenerationRef,
      collabDocumentRef,
      dirtyRef,
      documentTargetGenerationRef,
      editorElementRef,
      editVersionRef,
      selectedFileSourceRef,
      selectedFileRef,
      singleFileSourceRef,
      workspaceRuntimeRef,
    ],
  );
}
