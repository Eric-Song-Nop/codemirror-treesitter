import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  clearLiveMdThemeVariables,
  setLiveMdThemeVariables,
  type LiveMdThemeSpec,
  type LiveMdThemeVariableTarget,
} from "@codemirror-treesitter/live-md-theme";
import type { LiveMdPlugin, LiveMdPluginContext } from "./config.js";
import { liveMdImageSource, type LiveMdImageSourceResolver } from "./images.js";
import { liveMdLinkBase, type LiveMdLinkBaseUrl } from "./links.js";

export type LiveMdThemePluginOptions = {
  editor?: Extension;
  target?:
    | LiveMdThemeVariableTarget
    | ((context: LiveMdPluginContext) => LiveMdThemeVariableTarget | null | undefined);
  theme?: LiveMdThemeSpec | null;
};

export type LiveMdImageFilesInput = {
  files: File[];
  position?: number;
  view: EditorView;
};

export type LiveMdImageAssetsPluginOptions = {
  onFiles?: (input: LiveMdImageFilesInput) => Promise<void> | void;
  resolve?: LiveMdImageSourceResolver | null;
};

export type LiveMdLinkBehaviorPluginOptions = {
  baseUrl?: LiveMdLinkBaseUrl | null;
};

export function liveMdTheme(options: LiveMdThemePluginOptions): LiveMdPlugin {
  return {
    extension: options.editor ?? [],
    mount(context) {
      if (!options.theme) return;
      let target = liveMdThemeTarget(options.target, context);
      if (!target) return;
      setLiveMdThemeVariables(target, options.theme);
      return () => clearLiveMdThemeVariables(target);
    },
  };
}

export function liveMdImageAssets(options: LiveMdImageAssetsPluginOptions): LiveMdPlugin {
  return {
    extension: [liveMdImageSource(options.resolve), imageFilesExtension(options.onFiles)],
  };
}

export function liveMdLinkBehavior(options: LiveMdLinkBehaviorPluginOptions): LiveMdPlugin {
  return {
    extension: liveMdLinkBase(options.baseUrl),
  };
}

function liveMdThemeTarget(
  target: LiveMdThemePluginOptions["target"],
  context: LiveMdPluginContext,
): LiveMdThemeVariableTarget | null {
  if (typeof target == "function") return target(context) ?? null;
  if (target) return target;
  if (isShadowRoot(context.root) && isThemeVariableTarget(context.root.host)) {
    return context.root.host;
  }
  if (isThemeVariableTarget(context.parent)) return context.parent;
  return context.view.dom;
}

function imageFilesExtension(onFiles: LiveMdImageAssetsPluginOptions["onFiles"]): Extension {
  if (!onFiles) return [];
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
      void onFiles({ files, position, view });
      return true;
    },
    paste(event, view) {
      let files = imageFilesFromList(event.clipboardData?.files);
      if (!files.length) return false;
      event.preventDefault();
      void onFiles({ files, view });
      return true;
    },
  });
}

function hasImageItem(items: DataTransferItemList | null | undefined) {
  if (!items) return false;
  for (let index = 0; index < items.length; index++) {
    let item = items[index];
    if (item?.kind == "file" && isImageMimeType(item.type)) return true;
  }
  return false;
}

function imageFilesFromList(files: FileList | null | undefined) {
  return Array.from(files ?? []).filter(
    (file) => isImageMimeType(file.type) || isImageFileName(file.name),
  );
}

function isImageMimeType(type: string) {
  return type.startsWith("image/");
}

function isImageFileName(name: string) {
  return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(name);
}

function isThemeVariableTarget(value: unknown): value is LiveMdThemeVariableTarget {
  return (
    typeof value == "object" &&
    value != null &&
    typeof (value as LiveMdThemeVariableTarget).style?.setProperty == "function" &&
    typeof (value as LiveMdThemeVariableTarget).style?.removeProperty == "function"
  );
}

function isShadowRoot(value: unknown): value is ShadowRoot {
  return typeof ShadowRoot != "undefined" && value instanceof ShadowRoot;
}
