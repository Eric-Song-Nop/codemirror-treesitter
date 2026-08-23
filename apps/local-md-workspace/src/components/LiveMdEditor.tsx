import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { Extension } from "@codemirror/state";
import {
  liveMdTheme,
  type LiveMdConfig,
  type LiveMdEditorElement,
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
import { useLiveMdPreload } from "@/lib/editor/live-md-preload";
import { useTheme, type Theme } from "@/theme";

type LiveMdEditorProps = {
  documentKey: string;
  config?: LiveMdConfig;
  initialValue: string;
  placeholder: string;
  onEditorReady?: (editor: LiveMdEditorElement | null) => void;
  onInput: (value: string) => void;
};

const emptyLiveMdEditorConfig: LiveMdConfig = {};
const emptyLiveMdEditorPlugins: NonNullable<LiveMdConfig["plugins"]> = [];

export function LiveMdEditor({ ...props }: LiveMdEditorProps) {
  let { generation } = useLiveMdPreload();
  return <LiveMdEditorGeneration key={generation} {...props} />;
}

function LiveMdEditorGeneration({
  documentKey,
  config = emptyLiveMdEditorConfig,
  initialValue,
  placeholder,
  onEditorReady,
  onInput,
}: LiveMdEditorProps) {
  let { theme } = useTheme();
  let editorRef = useRef<LiveMdEditorElement | null>(null);
  let initialValueRef = useRef(initialValue);
  let onEditorReadyRef = useRef(onEditorReady);
  let onInputRef = useRef(onInput);

  initialValueRef.current = initialValue;
  onEditorReadyRef.current = onEditorReady;
  onInputRef.current = onInput;

  let themePlugin = useMemo(() => {
    let themeDefinition = liveMdThemeDefinition(theme);
    return liveMdTheme({
      editor: themeDefinition.codeMirrorTheme,
      theme: themeDefinition.liveMdTheme,
    });
  }, [theme]);
  let effectiveConfig = useMemo<LiveMdConfig>(
    () => ({
      markdown: config.markdown,
      plugins: [themePlugin, ...(config.plugins ?? emptyLiveMdEditorPlugins)],
    }),
    [config.markdown, config.plugins, themePlugin],
  );

  let setEditorRef = useCallback((editor: LiveMdEditorElement | null) => {
    editorRef.current = editor;
    if (!editor) return;
    editor.value = initialValueRef.current;
    editor.markClean();
  }, []);

  useLayoutEffect(() => {
    let editor = editorRef.current;
    if (!editor) return;
    if (editor.value != initialValue) editor.value = initialValue;
    editor.markClean();
  }, [documentKey, initialValue]);

  useLayoutEffect(() => {
    let editor = editorRef.current;
    if (!editor) return;
    editor.config = effectiveConfig;
  }, [effectiveConfig]);

  useLayoutEffect(() => {
    let editor = editorRef.current;
    if (!editor) return;
    let handleInput = () => onInputRef.current(editor.value);
    editor.addEventListener("input", handleInput);
    onEditorReadyRef.current?.(editor);
    return () => {
      editor.removeEventListener("input", handleInput);
      onEditorReadyRef.current?.(null);
      editor.config = {};
    };
  }, []);

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
