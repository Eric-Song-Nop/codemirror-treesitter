import type { Extension } from "@codemirror/state";
import type {
  LiveMdEditorElement,
  LiveMdImageSourceResolver,
} from "@codemirror-treesitter/live-md";
import { LiveMdEditor, type LiveMdImageFilesInput } from "@/components/LiveMdEditor";
import type { EditorDocument } from "@/lib/workspace/types";

type WorkspaceEditorPaneProps = {
  document: EditorDocument;
  extensions: Extension[];
  imageSource: LiveMdImageSourceResolver;
  placeholder: string;
  selected: boolean;
  onEditorReady: (editor: LiveMdEditorElement | null) => void;
  onImageFiles: (input: LiveMdImageFilesInput) => void;
  onInput: (value: string) => void;
};

export function WorkspaceEditorPane({
  document,
  extensions,
  imageSource,
  placeholder,
  selected,
  onEditorReady,
  onImageFiles,
  onInput,
}: WorkspaceEditorPaneProps) {
  return (
    <section className="local-md-editor min-h-0 flex-1">
      {selected ? (
        <LiveMdEditor
          documentKey={`${document.path}:${document.version}`}
          extensions={extensions}
          imageSource={imageSource}
          initialValue={document.value}
          placeholder={placeholder}
          onEditorReady={onEditorReady}
          onImageFiles={onImageFiles}
          onInput={onInput}
        />
      ) : (
        <div className="size-full bg-background" />
      )}
    </section>
  );
}
