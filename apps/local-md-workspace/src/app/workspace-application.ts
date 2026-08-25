import { createWorkspaceEffectRuntime } from "@/app/effect-runtime";
import { createWorkspaceAppStore } from "@/app/workspace-store";
import { WorkspaceDocumentViewCoordinator } from "@/app/document-view-coordinator";

export function createWorkspaceApplication() {
  let store = createWorkspaceAppStore();
  let documentViews = new WorkspaceDocumentViewCoordinator(store);
  let runtime = createWorkspaceEffectRuntime();
  let disposal: Promise<void> | null = null;

  return {
    dispose() {
      return (disposal ??= disposeWorkspaceApplication(documentViews, runtime));
    },
    documentViews,
    runtime,
    store,
  };
}

export type WorkspaceApplication = ReturnType<typeof createWorkspaceApplication>;

async function disposeWorkspaceApplication(
  documentViews: WorkspaceDocumentViewCoordinator,
  runtime: ReturnType<typeof createWorkspaceEffectRuntime>,
) {
  let viewError: unknown;
  try {
    documentViews.dispose();
  } catch (error) {
    viewError = error;
  }
  try {
    await runtime.dispose();
  } catch (error) {
    if (viewError) {
      throw new AggregateError([viewError, error], "Workspace application failed to close.");
    }
    throw error;
  }
  if (viewError) throw viewError;
}
