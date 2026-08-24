import type { LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import {
  getCollabDocumentValue,
  type CollabDocumentState,
} from "../../../collaboration/markdown-document.ts";
import type { WorkspaceAgentHost } from "../../application/host-port.ts";
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
  collabDocumentRef: MutableRef<CollabDocumentState | null>;
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
  if (!binding) return createWorkspaceAgentHost({ runtime });

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
          document.metadata.docId != binding.documentId ||
          document.metadata.path != binding.path ||
          document.metadata.workspaceId != binding.documentWorkspaceId ||
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
          value: getCollabDocumentValue(document),
          view,
          workspaceId: binding.workspaceId,
        };
      },
    },
    runtime,
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
    document.docId != document.metadata.docId ||
    document.path != document.metadata.path ||
    documentWorkspaceId != document.metadata.workspaceId
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
