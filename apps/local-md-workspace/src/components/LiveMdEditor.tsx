import { useEffect, useRef, type RefObject } from "react";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  liveMdCodeFenceHighlighting,
  liveMdImageSource,
  type LiveMdEditorElement,
  type LiveMdImageSourceResolver,
} from "@codemirror-treesitter/live-md";
import "@codemirror-treesitter/live-md/register";
import {
  gruvboxDark,
  gruvboxDarkHighlightStyle,
  gruvboxLight,
  gruvboxLightHighlightStyle,
} from "@codemirror-treesitter/theme-gruvbox";
import {
  catppuccinLatte,
  catppuccinLatteHighlightStyle,
  catppuccinMacchiato,
  catppuccinMacchiatoHighlightStyle,
  githubLight,
  githubLightHighlightStyle,
} from "@/theme/codemirror-theme-extensions";
import { useTheme, type Theme } from "@/theme";

export type LiveMdImageFilesInput = {
  files: File[];
  position?: number;
  view: EditorView;
};

type LiveMdEditorProps = {
  documentKey: string;
  extensions?: Extension[];
  imageSource?: LiveMdImageSourceResolver | null;
  initialValue: string;
  placeholder: string;
  onEditorReady?: (editor: LiveMdEditorElement | null) => void;
  onImageFiles?: (input: LiveMdImageFilesInput) => void;
  onInput: (value: string) => void;
};

export function LiveMdEditor({
  documentKey,
  extensions: extraExtensions = [],
  imageSource,
  initialValue,
  placeholder,
  onEditorReady,
  onImageFiles,
  onInput,
}: LiveMdEditorProps) {
  let { theme } = useTheme();
  let editorRef = useRef<LiveMdEditorElement | null>(null);
  let onImageFilesRef = useRef(onImageFiles);
  let onInputRef = useRef(onInput);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    onImageFilesRef.current = onImageFiles;
  }, [onImageFiles]);

  useEffect(() => {
    let editor = editorRef.current;
    if (!editor || editor.value == initialValue) return;
    editor.value = initialValue;
    editor.markClean();
  }, [documentKey, initialValue]);

  useEffect(() => {
    let editor = editorRef.current;
    if (!editor) return;

    let extensions: Extension[] = [
      ...liveMdThemeExtensions(theme),
      liveMdImageSource(imageSource),
      ...extraExtensions,
    ];
    if (onImageFiles) extensions.push(imageInputExtension(onImageFilesRef));
    editor.extensions = extensions;

    let handleInput = () => onInputRef.current(editor.value);
    editor.addEventListener("input", handleInput);
    onEditorReady?.(editor);
    return () => {
      editor.removeEventListener("input", handleInput);
      onEditorReady?.(null);
      editor.extensions = [];
    };
  }, [extraExtensions, imageSource, onEditorReady, onImageFiles, theme]);

  return (
    <live-md-editor
      ref={editorRef}
      className="local-md-live-editor block size-full min-h-0"
      data-theme={theme}
      placeholder={placeholder}
    />
  );
}

const liveMdGruvboxDarkExtensions: Extension[] = [
  gruvboxDark,
  liveMdCodeFenceHighlighting(gruvboxDarkHighlightStyle),
];

const liveMdGruvboxLightExtensions: Extension[] = [
  gruvboxLight,
  liveMdCodeFenceHighlighting(gruvboxLightHighlightStyle),
];

const liveMdGithubLightExtensions: Extension[] = [
  githubLight,
  liveMdCodeFenceHighlighting(githubLightHighlightStyle),
];

const liveMdCatppuccinLatteExtensions: Extension[] = [
  catppuccinLatte,
  liveMdCodeFenceHighlighting(catppuccinLatteHighlightStyle),
];

const liveMdCatppuccinMacchiatoExtensions: Extension[] = [
  catppuccinMacchiato,
  liveMdCodeFenceHighlighting(catppuccinMacchiatoHighlightStyle),
];

function liveMdThemeExtensions(theme: Theme) {
  switch (theme) {
    case "catppuccin-latte":
      return liveMdCatppuccinLatteExtensions;
    case "catppuccin-macchiato":
      return liveMdCatppuccinMacchiatoExtensions;
    case "github-light":
      return liveMdGithubLightExtensions;
    case "gruvbox-dark":
      return liveMdGruvboxDarkExtensions;
    case "gruvbox-light":
      return liveMdGruvboxLightExtensions;
  }
}

function imageInputExtension(onImageFilesRef: RefObject<LiveMdEditorProps["onImageFiles"]>) {
  return EditorView.domEventHandlers({
    dragover(event) {
      if (!hasImageItem(event.dataTransfer?.items)) return false;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      return true;
    },
    drop(event, view) {
      let files = imageFilesFromList(event.dataTransfer?.files);
      if (!files.length) return false;
      event.preventDefault();
      let position =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      onImageFilesRef.current?.({ files, position, view });
      return true;
    },
    paste(event, view) {
      let files = imageFilesFromList(event.clipboardData?.files);
      if (!files.length) return false;
      event.preventDefault();
      onImageFilesRef.current?.({ files, view });
      return true;
    },
  });
}

function hasImageItem(items: DataTransferItemList | null | undefined) {
  if (!items) return false;
  for (let index = 0; index < items.length; index++) {
    let item = items[index];
    if (item?.kind == "file" && item.type.startsWith("image/")) return true;
  }
  return false;
}

function imageFilesFromList(files: FileList | null | undefined) {
  return Array.from(files ?? []).filter(
    (file) =>
      file.type.startsWith("image/") || /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(file.name),
  );
}
