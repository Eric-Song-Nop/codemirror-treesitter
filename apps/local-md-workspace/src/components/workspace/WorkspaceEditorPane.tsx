import type { LiveMdEditorElement, LiveMdPlugin } from "@codemirror-treesitter/live-md";
import { LiveMdEditor } from "@/components/LiveMdEditor";
import type { EditorDocument } from "@/lib/workspace/types";

type WorkspaceEditorPaneProps = {
  document: EditorDocument;
  placeholder: string;
  plugins: readonly LiveMdPlugin[];
  selected: boolean;
  onEditorReady: (editor: LiveMdEditorElement | null) => void;
  onInput: (value: string) => void;
};

export function WorkspaceEditorPane({
  document,
  placeholder,
  plugins,
  selected,
  onEditorReady,
  onInput,
}: WorkspaceEditorPaneProps) {
  return (
    <section className="local-md-editor min-h-0 flex-1">
      {selected ? (
        <LiveMdEditor
          documentKey={`${document.path}:${document.version}`}
          initialValue={document.value}
          placeholder={placeholder}
          plugins={plugins}
          onEditorReady={onEditorReady}
          onInput={onInput}
        />
      ) : (
        <div className="size-full bg-background" />
      )}
    </section>
  );
}
