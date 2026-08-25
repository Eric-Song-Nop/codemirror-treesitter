import { Layer, ManagedRuntime } from "effect";
import { WorkspaceRuntimeTransitions } from "@/lib/workspace/runtime/runtime-lifecycle";

export function createWorkspaceEffectRuntime() {
  return ManagedRuntime.make(Layer.mergeAll(WorkspaceRuntimeTransitions.layer));
}

export type WorkspaceEffectRuntime = ReturnType<typeof createWorkspaceEffectRuntime>;
