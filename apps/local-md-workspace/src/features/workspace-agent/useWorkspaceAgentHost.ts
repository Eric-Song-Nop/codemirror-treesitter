import { useCallback } from "react";
import {
  createWorkspaceAgentRunHost,
  type CreateWorkspaceAgentRunHost,
  type WorkspaceAgentHostRefs,
} from "@/lib/agent/adapters/workspace/run-host";

export type { CreateWorkspaceAgentRunHost, WorkspaceAgentHostRefs };

/**
 * Returns a stable factory. Calling it starts a new workspace-bound Agent run.
 * The refs stay live so workspace and standalone-file transitions are observed
 * without coupling the run host to the selected editor view.
 */
export function useWorkspaceAgentHost(input: WorkspaceAgentHostRefs): CreateWorkspaceAgentRunHost {
  let { singleFileSourceRef, workspaceRuntimeRef } = input;

  return useCallback(
    () =>
      createWorkspaceAgentRunHost({
        singleFileSourceRef,
        workspaceRuntimeRef,
      }),
    [singleFileSourceRef, workspaceRuntimeRef],
  );
}
