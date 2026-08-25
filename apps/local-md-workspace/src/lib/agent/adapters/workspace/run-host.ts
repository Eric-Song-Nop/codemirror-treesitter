import type { LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import type { WorkspaceAgentHost } from "../../application/host-port.ts";
import type { WorkspaceCollaborativeDocument } from "../../../workspace/documents/contracts.ts";
import type { WorkspaceRuntime } from "../../../workspace/runtime/types.ts";
import { workspaceNamespace } from "../../../workspace/source-identity.ts";
import type { MarkdownFileNode } from "../../../workspace/tree.ts";
import type { ActiveDocumentSource, SingleFileSource } from "../../../workspace/types.ts";
import { createWorkspaceAgentHost } from "./host.ts";

type MutableRef<T> = {
  current: T;
};

export type WorkspaceAgentHostRefs = {
  activeDocumentGenerationRef: MutableRef<number>;
  collabDocumentRef: MutableRef<WorkspaceCollaborativeDocument | null>;
  dirtyRef: MutableRef<boolean>;
  documentTargetGenerationRef: MutableRef<number>;
  editorElementRef: MutableRef<LiveMdEditorElement | null>;
  editVersionRef: MutableRef<number>;
  selectedFileSourceRef: MutableRef<ActiveDocumentSource | null>;
  selectedFileRef: MutableRef<MarkdownFileNode | null>;
  singleFileSourceRef: MutableRef<SingleFileSource | null>;
  workspaceRuntimeRef: MutableRef<WorkspaceRuntime | null>;
};

export type CreateWorkspaceAgentRunHost = () => WorkspaceAgentHost | null;

export function createWorkspaceAgentRunHost(
  input: WorkspaceAgentHostRefs,
): WorkspaceAgentHost | null {
  let runtime = input.workspaceRuntimeRef.current;
  if (!runtime || input.singleFileSourceRef.current) return null;

  let binding = captureActiveEditorBinding(input, runtime);
  if (!binding) return createWorkspaceAgentHost({ runtime: agentReadRuntime(runtime) });

  return createWorkspaceAgentHost({
    activeEditor: {
      getActiveEditor: () => {
        let document = input.collabDocumentRef.current;
        let editor = input.editorElementRef.current;
        let view = editor?.view ?? null;
        if (
          input.workspaceRuntimeRef.current !== binding.runtime ||
          binding.runtime.identity.id != binding.workspaceId ||
          input.selectedFileSourceRef.current !== binding.runtime ||
          input.selectedFileRef.current?.path != binding.path ||
          input.singleFileSourceRef.current != null ||
          document !== binding.document ||
          document.docId != binding.documentId ||
          document.path != binding.path ||
          document.collabState.metadata.docId != binding.documentId ||
          document.collabState.metadata.path != binding.path ||
          document.collabState.metadata.workspaceId != binding.documentWorkspaceId ||
          input.activeDocumentGenerationRef.current != binding.documentGeneration ||
          input.documentTargetGenerationRef.current != binding.targetGeneration ||
          editor !== binding.editor ||
          view !== binding.view
        ) {
          return null;
        }

        return {
          dirty: input.dirtyRef.current,
          documentGeneration: binding.documentGeneration,
          documentId: binding.documentId,
          editVersion: input.editVersionRef.current,
          path: binding.path,
          targetGeneration: binding.targetGeneration,
          value: document.read(),
          view,
          workspaceId: binding.workspaceId,
        };
      },
    },
    runtime: agentReadRuntime(runtime),
  });
}

function captureActiveEditorBinding(input: WorkspaceAgentHostRefs, runtime: WorkspaceRuntime) {
  let file = input.selectedFileRef.current;
  let document = input.collabDocumentRef.current;
  let editor = input.editorElementRef.current;
  let view = editor?.view ?? null;
  let workspaceId = runtime.identity.id;
  let documentWorkspaceId = workspaceNamespace(runtime.identity);
  if (
    input.workspaceRuntimeRef.current !== runtime ||
    input.selectedFileSourceRef.current !== runtime ||
    input.singleFileSourceRef.current != null ||
    !file ||
    !document ||
    !editor ||
    !view ||
    file.path != document.path ||
    document.docId != document.collabState.metadata.docId ||
    document.path != document.collabState.metadata.path ||
    documentWorkspaceId != document.collabState.metadata.workspaceId
  ) {
    return null;
  }

  return {
    document,
    documentGeneration: input.activeDocumentGenerationRef.current,
    documentId: document.docId,
    documentWorkspaceId,
    editor,
    path: file.path,
    runtime,
    targetGeneration: input.documentTargetGenerationRef.current,
    view,
    workspaceId,
  };
}

function agentReadRuntime(runtime: WorkspaceRuntime) {
  return {
    documents: runtime.documentSource,
    entries: runtime.entries,
    identity: runtime.identity,
    tree: runtime.tree,
  };
}
