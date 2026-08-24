import { createWorkspaceEffectRuntime } from "@/app/effect-runtime";
import { createWorkspaceAppStore } from "@/app/workspace-store";
import {
  createWorkspaceDocumentSessionController,
  createWorkspaceDocumentSessionKernel,
} from "@/app/document-session-coordinator";

export function createWorkspaceApplication() {
  let store = createWorkspaceAppStore();
  let documentSessionKernel = createWorkspaceDocumentSessionKernel(store);
  let runtime = createWorkspaceEffectRuntime(documentSessionKernel);
  let documents = createWorkspaceDocumentSessionController(documentSessionKernel, (effect) =>
    runtime.runPromise(effect),
  );
  let disposal: Promise<void> | null = null;

  return {
    dispose() {
      return (disposal ??= runtime.dispose());
    },
    documents,
    runtime,
    store,
  };
}

export type WorkspaceApplication = ReturnType<typeof createWorkspaceApplication>;
