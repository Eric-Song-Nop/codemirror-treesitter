import { Layer, ManagedRuntime } from "effect";
import {
  WorkspaceDocumentSessionCoordinator,
  type WorkspaceDocumentSessionKernel,
} from "@/app/document-session-coordinator";
import { WorkspaceRuntimeTransitions } from "@/lib/workspace/runtime/runtime-lifecycle";

export function createWorkspaceEffectRuntime(documentSessions: WorkspaceDocumentSessionKernel) {
  return ManagedRuntime.make(
    Layer.mergeAll(
      WorkspaceRuntimeTransitions.layer,
      WorkspaceDocumentSessionCoordinator.layer(documentSessions),
    ),
  );
}

export type WorkspaceEffectRuntime = ReturnType<typeof createWorkspaceEffectRuntime>;
