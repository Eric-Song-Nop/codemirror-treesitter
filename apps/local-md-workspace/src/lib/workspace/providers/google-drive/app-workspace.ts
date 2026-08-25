import type { WorkspaceDocumentPort, WorkspaceEntryPort } from "@/lib/workspace/runtime/types";
import { GOOGLE_DRIVE_WORKSPACE_ROOT } from "./config.ts";

export const GOOGLE_DRIVE_APP_WORKSPACE_MANIFEST_PATH = ".grove/workspace.json";

export async function ensureGoogleDriveAppWorkspaceRoot(runtime: {
  entries: Pick<WorkspaceEntryPort, "create">;
}) {
  await runtime.entries.create(`${GOOGLE_DRIVE_WORKSPACE_ROOT}/`);
}

export async function ensureGoogleDriveAppWorkspaceManifest(runtime: {
  documentSource: Pick<WorkspaceDocumentPort, "commit" | "observe">;
}) {
  let observation = await runtime.documentSource.observe(GOOGLE_DRIVE_APP_WORKSPACE_MANIFEST_PATH);
  if (observation.state == "present") return;
  if (observation.state == "unavailable") throw observation.error;

  let result = await runtime.documentSource.commit({
    condition: { kind: "if-absent" },
    path: GOOGLE_DRIVE_APP_WORKSPACE_MANIFEST_PATH,
    value: googleDriveAppWorkspaceManifest(),
  });
  if (result.status == "unknown") {
    throw new Error("Google Drive workspace manifest write outcome is unknown.");
  }
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
