import { createWorkspaceEffectRuntime } from "@/app/effect-runtime";
import { createWorkspaceAppStore } from "@/app/workspace-store";

export function createWorkspaceApplication() {
  let runtime = createWorkspaceEffectRuntime();
  let store = createWorkspaceAppStore();
  let disposal: Promise<void> | null = null;

  return {
    dispose() {
      return (disposal ??= runtime.dispose());
    },
    runtime,
    store,
  };
}

export type WorkspaceApplication = ReturnType<typeof createWorkspaceApplication>;
