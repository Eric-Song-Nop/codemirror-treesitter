import { useEffect, useLayoutEffect, useState } from "react";
import type { WorkspaceApplication } from "@/app/workspace-application";
import {
  WorkspaceEditorSession,
  type WorkspaceEditorSessionSharePorts,
} from "@/hooks/workspace/workspace-editor-session";

/**
 * Creates the editor session once per workspace application and connects the
 * React-owned share state to it. The session itself holds no React state.
 */
export function useWorkspaceEditorSession(
  application: Pick<WorkspaceApplication, "documentViews" | "runtime" | "store">,
  sharePorts: WorkspaceEditorSessionSharePorts,
) {
  let [session] = useState(
    () =>
      new WorkspaceEditorSession({
        documentViews: application.documentViews,
        effectRuntime: application.runtime,
        store: application.store,
      }),
  );
  let { setActiveShareRecord, setCreatedShare, startOwnerShareHost } = sharePorts;

  useLayoutEffect(
    () => session.connectShareHost({ setActiveShareRecord, setCreatedShare, startOwnerShareHost }),
    [session, setActiveShareRecord, setCreatedShare, startOwnerShareHost],
  );

  useEffect(() => () => session.disposeWorkspaceRuntime(), [session]);

  return session;
}
