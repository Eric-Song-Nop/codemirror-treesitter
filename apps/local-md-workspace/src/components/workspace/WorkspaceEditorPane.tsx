import type { LiveMdConfig, LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import { LiveMdEditor } from "@/components/LiveMdEditor";
import type { EditorDocument } from "@/lib/workspace/types";

type WorkspaceEditorPaneProps = {
  document: EditorDocument;
  liveMdConfig: LiveMdConfig;
  placeholder: string;
  selected: boolean;
  onEditorReady: (editor: LiveMdEditorElement | null) => void;
  onInput: (value: string) => void;
};

export function WorkspaceEditorPane({
  document,
  liveMdConfig,
  placeholder,
  selected,
  onEditorReady,
  onInput,
}: WorkspaceEditorPaneProps) {
  return (
    <section className="local-md-editor min-h-0 flex-1">
      {selected ? (
        <LiveMdEditor
          config={liveMdConfig}
          documentKey={`${document.path}:${document.version}`}
          initialValue={document.value}
          placeholder={placeholder}
          onEditorReady={onEditorReady}
          onInput={onInput}
        />
      ) : (
        <div className="size-full bg-background" />
      )}
    </section>
  );
}
