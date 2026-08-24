import { Layer, ManagedRuntime } from "effect";
import {
  createWorkspaceDocumentSessionKernel,
  WorkspaceDocumentSessionCoordinator,
  type WorkspaceDocumentSessionKernel,
} from "@/app/document-session-coordinator";
import { createWorkspaceAppStore } from "@/app/workspace-store";
import { WorkspaceRuntimeTransitions } from "@/lib/workspace/runtime/runtime-lifecycle";

export function createWorkspaceEffectRuntime(
  documentSessions: WorkspaceDocumentSessionKernel = createWorkspaceDocumentSessionKernel(
    createWorkspaceAppStore(),
  ),
) {
  return ManagedRuntime.make(
    Layer.mergeAll(
      WorkspaceRuntimeTransitions.layer,
      WorkspaceDocumentSessionCoordinator.layer(documentSessions),
    ),
  );
}

export type WorkspaceEffectRuntime = ReturnType<typeof createWorkspaceEffectRuntime>;
