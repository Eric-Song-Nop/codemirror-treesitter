import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  liveMdImageSource,
  type LiveMdEditorElement,
  type LiveMdImageSourceResolver,
} from "@codemirror-treesitter/live-md";
import {
  clearLiveMdThemeVariables,
  setLiveMdThemeVariables,
  type LiveMdThemeSpec,
} from "@codemirror-treesitter/live-md-theme";
import { gruvboxDark, gruvboxLight } from "@codemirror-treesitter/theme-gruvbox";
import { catppuccinLatte, catppuccinMacchiato } from "@codemirror-treesitter/theme-catppuccin";
import { githubLight } from "@codemirror-treesitter/theme-github";
import {
  gruvboxDarkLiveMdTheme,
  gruvboxLightLiveMdTheme,
} from "@codemirror-treesitter/live-md-theme-gruvbox";
import {
  catppuccinLatteLiveMdTheme,
  catppuccinMacchiatoLiveMdTheme,
} from "@codemirror-treesitter/live-md-theme-catppuccin";
import { githubLightLiveMdTheme } from "@codemirror-treesitter/live-md-theme-github";
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

const emptyLiveMdEditorExtensions: Extension[] = [];

export function LiveMdEditor({
  documentKey,
  extensions: extraExtensions = emptyLiveMdEditorExtensions,
  imageSource,
  initialValue,
  placeholder,
  onEditorReady,
  onImageFiles,
  onInput,
}: LiveMdEditorProps) {
  let { theme } = useTheme();
  let editorRef = useRef<LiveMdEditorElement | null>(null);
  let initialValueRef = useRef(initialValue);
  let onImageFilesRef = useRef(onImageFiles);
  let onInputRef = useRef(onInput);

  initialValueRef.current = initialValue;

  let setEditorRef = useCallback((editor: LiveMdEditorElement | null) => {
    editorRef.current = editor;
    if (!editor) return;
    editor.value = initialValueRef.current;
    editor.markClean();
  }, []);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    onImageFilesRef.current = onImageFiles;
  }, [onImageFiles]);

  useLayoutEffect(() => {
    let editor = editorRef.current;
    if (!editor) return;
    if (editor.value != initialValue) editor.value = initialValue;
    editor.markClean();
  }, [documentKey, initialValue]);

  useLayoutEffect(() => {
    let editor = editorRef.current;
    if (!editor) return;

    let themeDefinition = liveMdThemeDefinition(theme);
    setLiveMdThemeVariables(editor, themeDefinition.liveMdTheme);

    let extensions: Extension[] = [
      themeDefinition.codeMirrorTheme,
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
      clearLiveMdThemeVariables(editor);
    };
  }, [extraExtensions, imageSource, onEditorReady, onImageFiles, theme]);

  return (
    <live-md-editor
      ref={setEditorRef}
      className="local-md-live-editor block size-full min-h-0"
      data-theme={theme}
      placeholder={placeholder}
    />
  );
}

type LiveMdThemeDefinition = {
  codeMirrorTheme: Extension;
  liveMdTheme: LiveMdThemeSpec;
};

const liveMdThemeDefinitionMap = {
  "catppuccin-latte": {
    codeMirrorTheme: catppuccinLatte,
    liveMdTheme: catppuccinLatteLiveMdTheme,
  },
  "catppuccin-macchiato": {
    codeMirrorTheme: catppuccinMacchiato,
    liveMdTheme: catppuccinMacchiatoLiveMdTheme,
  },
  "github-light": {
    codeMirrorTheme: githubLight,
    liveMdTheme: githubLightLiveMdTheme,
  },
  "gruvbox-dark": {
    codeMirrorTheme: gruvboxDark,
    liveMdTheme: gruvboxDarkLiveMdTheme,
  },
  "gruvbox-light": {
    codeMirrorTheme: gruvboxLight,
    liveMdTheme: gruvboxLightLiveMdTheme,
  },
} satisfies Record<Theme, LiveMdThemeDefinition>;

function liveMdThemeDefinition(theme: Theme) {
  return liveMdThemeDefinitionMap[theme];
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
