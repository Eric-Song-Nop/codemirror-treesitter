import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { workspaceLiveObjects, type WorkspaceAppStore } from "@/app/workspace-store";

/**
 * The slice of workspace state the root component renders from. It deliberately
 * excludes high-frequency fields (save state, busy flags, error text, editor
 * versions) so typing and saving re-render only the components that show them.
 */
export function useWorkspaceRootState(store: WorkspaceAppStore) {
  let state = useStore(
    store,
    useShallow((snapshot) => ({
      agentActivated: snapshot.agentActivated,
      agentOpen: snapshot.agentOpen,
      documentSourceKind: snapshot.documentSourceKind,
      documentView: snapshot.documentView,
      editorDocumentPath: snapshot.editorDocument.path,
      recoveryDialogAction: snapshot.recoveryDialogAction,
      selectedFile: snapshot.selectedFile,
      sidebarOpen: snapshot.sidebarOpen,
      singleFileSource: snapshot.singleFileSource,
      storedDropboxConfig: snapshot.storedDropboxConfig,
      storedLocalWorkspace: snapshot.storedLocalWorkspace,
      storedWorkspaceKind: snapshot.storedWorkspaceKind,
      tree: snapshot.tree,
      treeSelection: snapshot.treeSelection,
      workspace: snapshot.workspace,
    })),
  );
  let live = workspaceLiveObjects(store);
  return {
    ...state,
    collabDocument: state.documentView ? live.collabDocument : null,
    workspaceRuntime: state.workspace ? live.workspaceRuntime : null,
  };
}
