import { useEffect, useRef } from "react";
import type { LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import "@codemirror-treesitter/live-md/register";
import { gruvboxDark } from "@codemirror-treesitter/theme-gruvbox";

type LiveMdEditorProps = {
  documentKey: string;
  initialValue: string;
  placeholder: string;
  onInput: (value: string) => void;
};

export function LiveMdEditor({
  documentKey,
  initialValue,
  placeholder,
  onInput,
}: LiveMdEditorProps) {
  let editorRef = useRef<LiveMdEditorElement | null>(null);
  let onInputRef = useRef(onInput);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    let editor = editorRef.current;
    if (!editor || editor.value == initialValue) return;
    editor.value = initialValue;
    editor.markClean();
  }, [documentKey, initialValue]);

  useEffect(() => {
    let editor = editorRef.current;
    if (!editor) return;

    editor.extensions = gruvboxDark;
    let handleInput = () => onInputRef.current(editor.value);
    editor.addEventListener("input", handleInput);
    return () => {
      editor.removeEventListener("input", handleInput);
      editor.extensions = [];
    };
  }, []);

  return (
    <live-md-editor
      ref={editorRef}
      className="local-md-live-editor block size-full min-h-0"
      placeholder={placeholder}
    />
  );
}
