import type { LiveMdConfig, LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import { LiveMdEditor } from "@/components/LiveMdEditor";
import { Spinner } from "@/components/ui/spinner";
import type { EditorDocument } from "@/lib/workspace/types";

type WorkspaceEditorPaneProps = {
  document: EditorDocument;
  liveMdConfig: LiveMdConfig;
  loadingLabel?: string;
  placeholder: string;
  selected: boolean;
  onEditorReady: (editor: LiveMdEditorElement | null) => void;
  onInput: (value: string) => void;
};

export function WorkspaceEditorPane({
  document,
  liveMdConfig,
  loadingLabel,
  placeholder,
  selected,
  onEditorReady,
  onInput,
}: WorkspaceEditorPaneProps) {
  return (
    <section className="local-md-editor relative min-h-0 flex-1">
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
      {loadingLabel && (
        <div className="absolute inset-0 grid place-items-center bg-background/80">
          <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm text-muted-foreground shadow-sm">
            <Spinner aria-hidden />
            <span className="max-w-[min(28rem,80vw)] truncate">{loadingLabel}</span>
          </div>
        </div>
      )}
    </section>
  );
}
