import type { WorkspaceBackend } from "@/lib/workspace-backend";
import { GOOGLE_DRIVE_WORKSPACE_ROOT } from "./google-drive-config.ts";

export const GOOGLE_DRIVE_APP_WORKSPACE_MANIFEST_PATH = ".grove/workspace.json";

type GoogleDriveRootBackend = Pick<WorkspaceBackend, "createDirectory">;
type GoogleDriveWorkspaceBackend = Pick<WorkspaceBackend, "stat" | "writeFile" | "writeTextFile">;

export async function ensureGoogleDriveAppWorkspaceRoot(backend: GoogleDriveRootBackend) {
  if (!backend.createDirectory) {
    throw new Error("Google Drive workspace cannot create the Grove root folder.");
  }
  await backend.createDirectory(GOOGLE_DRIVE_WORKSPACE_ROOT);
}

export async function ensureGoogleDriveAppWorkspaceManifest(backend: GoogleDriveWorkspaceBackend) {
  let stat = await backend.stat?.(GOOGLE_DRIVE_APP_WORKSPACE_MANIFEST_PATH);
  if (stat?.exists) return;

  let manifest = googleDriveAppWorkspaceManifest();
  if (backend.writeTextFile) {
    await backend.writeTextFile(GOOGLE_DRIVE_APP_WORKSPACE_MANIFEST_PATH, manifest);
    return;
  }
  await backend.writeFile(GOOGLE_DRIVE_APP_WORKSPACE_MANIFEST_PATH, manifest);
}

function googleDriveAppWorkspaceManifest() {
  return `${JSON.stringify(
    {
      kind: "grove.googleDriveWorkspace",
      root: GOOGLE_DRIVE_WORKSPACE_ROOT,
      version: 1,
    },
    null,
    2,
  )}\n`;
}
