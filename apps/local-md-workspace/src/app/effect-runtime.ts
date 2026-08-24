import { ManagedRuntime } from "effect";
import { WorkspaceRuntimeTransitions } from "@/lib/workspace/runtime/runtime-lifecycle";

export function createWorkspaceEffectRuntime() {
  return ManagedRuntime.make(WorkspaceRuntimeTransitions.layer);
}

export type WorkspaceEffectRuntime = ReturnType<typeof createWorkspaceEffectRuntime>;
