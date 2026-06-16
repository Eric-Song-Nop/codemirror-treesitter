import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Extension } from "@codemirror/state";
import {
  liveMdTheme,
  type LiveMdEditorElement,
  type LiveMdPlugin,
} from "@codemirror-treesitter/live-md";
import type { LiveMdThemeSpec } from "@codemirror-treesitter/live-md-theme";
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

type LiveMdEditorProps = {
  documentKey: string;
  initialValue: string;
  placeholder: string;
  plugins?: readonly LiveMdPlugin[];
  onEditorReady?: (editor: LiveMdEditorElement | null) => void;
  onInput: (value: string) => void;
};

const emptyLiveMdEditorPlugins: readonly LiveMdPlugin[] = [];

export function LiveMdEditor({
  documentKey,
  initialValue,
  placeholder,
  plugins: extraPlugins = emptyLiveMdEditorPlugins,
  onEditorReady,
  onInput,
}: LiveMdEditorProps) {
  let { theme } = useTheme();
  let editorRef = useRef<LiveMdEditorElement | null>(null);
  let initialValueRef = useRef(initialValue);
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
    editor.plugins = [
      liveMdTheme({
        editor: themeDefinition.codeMirrorTheme,
        target: editor,
        theme: themeDefinition.liveMdTheme,
      }),
      ...extraPlugins,
    ];

    let handleInput = () => onInputRef.current(editor.value);
    editor.addEventListener("input", handleInput);
    onEditorReady?.(editor);
    return () => {
      editor.removeEventListener("input", handleInput);
      onEditorReady?.(null);
      editor.plugins = [];
    };
  }, [extraPlugins, onEditorReady, theme]);

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
