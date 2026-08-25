import type { WorkspaceRuntime } from "../../../workspace/runtime/types.ts";
import type { SingleFileSource } from "../../../workspace/types.ts";
import { createWorkspaceAgentHost } from "./host.ts";
import type { WorkspaceAgentHost } from "../../application/host-port.ts";

type MutableRef<T> = {
  current: T;
};

export type WorkspaceAgentHostRefs = {
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
  workspaceRuntimeRef: MutableRef<WorkspaceRuntime | null>;
};

export type CreateWorkspaceAgentRunHost = () => WorkspaceAgentHost | null;

export function createWorkspaceAgentRunHost(
  input: WorkspaceAgentHostRefs,
): WorkspaceAgentHost | null {
  let runtime = input.workspaceRuntimeRef.current;
  if (!runtime || input.singleFileSourceRef.current) return null;

  return createWorkspaceAgentHost({
    runtime: {
      documents: runtime.documents,
      identity: runtime.identity,
      tree: runtime.tree,
    },
  });
}
