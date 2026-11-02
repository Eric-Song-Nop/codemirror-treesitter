import { Layer, ManagedRuntime } from "effect";
import { DropboxWorkspaces } from "@/lib/workspace/providers/dropbox/dropbox-workspaces";
import { LocalWorkspaceStorage } from "@/lib/workspace/runtime/browser-local-runtime";
import { CloudWorkspaceStorage } from "@/lib/workspace/runtime/cloud-runtime";
import { WorkspaceRuntimeTransitions } from "@/lib/workspace/runtime/runtime-lifecycle";
import { OpendalOperators } from "@/lib/workspace/storage/opendal-operators";

/**
 * The application's Effect services:
 *
 * - `WorkspaceRuntimeTransitions` owns the active workspace runtime's scope.
 * - `LocalWorkspaceStorage` opens File System Access folders.
 * - `CloudWorkspaceStorage` opens OpenDAL cloud workspaces.
 * - `DropboxWorkspaces` holds the Dropbox session and opens Dropbox workspaces.
 * - `OpendalOperators` opens OpenDAL WASM operators (shared by both storages).
 */
export const workspaceAppLayer = Layer.mergeAll(
  WorkspaceRuntimeTransitions.layer,
  LocalWorkspaceStorage.layerNoDeps,
  CloudWorkspaceStorage.layerNoDeps,
  DropboxWorkspaces.layerNoDeps.pipe(Layer.provide(CloudWorkspaceStorage.layerNoDeps)),
).pipe(Layer.provide(OpendalOperators.layer));

export type WorkspaceAppServices = Layer.Success<typeof workspaceAppLayer>;

export function createWorkspaceEffectRuntime(
  layer: Layer.Layer<WorkspaceAppServices> = workspaceAppLayer,
) {
  return ManagedRuntime.make(layer);
}

export type WorkspaceEffectRuntime = ManagedRuntime.ManagedRuntime<WorkspaceAppServices, never>;
