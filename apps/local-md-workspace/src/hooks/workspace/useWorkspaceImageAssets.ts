import { useCallback, useEffect, useMemo, useRef, type ChangeEvent, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EditorView } from "@codemirror/view";
import {
  liveMdImageAssets,
  type LiveMdEditorElement,
  type LiveMdImageFilesInput,
  type LiveMdImageSourceResolver,
  type LiveMdPlugin,
} from "@codemirror-treesitter/live-md";
import { useWorkspaceImageAssetStore } from "@/hooks/workspace/useWorkspaceImageAssetStore";
import { errorToMessage } from "@/lib/workspace/errors";
import {
  createWorkspaceImageAssetFromBytes,
  insertImageMarkdown,
  isImageFile,
  isImageFileName,
} from "@/lib/workspace/images";
import { resolveMarkdownImagePath } from "@/lib/workspace/markdown-images";
import {
  readWorkspaceImageBytes,
  removeWorkspaceImageQueries,
} from "@/lib/workspace/workspace-data-cache";
import type { EditorDocument, SingleFileSource, WorkspaceImageAsset } from "@/lib/workspace/types";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";

type UseWorkspaceImageAssetsOptions = {
  editorDocument: EditorDocument;
  editorElementRef: RefObject<LiveMdEditorElement | null>;
  selectedFile: MarkdownFileNode | null;
  selectedFileRef: RefObject<MarkdownFileNode | null>;
  setBusy: (busy: boolean) => void;
  setErrorMessage: (message: string) => void;
  singleFileSource: SingleFileSource | null;
  singleFileSourceRef: RefObject<SingleFileSource | null>;
  workspaceBackend: WorkspaceBackend | null;
  workspaceBackendRef: RefObject<WorkspaceBackend | null>;
};

export function useWorkspaceImageAssets({
  editorDocument,
  editorElementRef,
  selectedFile,
  selectedFileRef,
  setBusy,
  setErrorMessage,
  singleFileSource,
  singleFileSourceRef,
  workspaceBackend,
  workspaceBackendRef,
}: UseWorkspaceImageAssetsOptions) {
  let queryClient = useQueryClient();
  let {
    clear: clearImageAssets,
    get: getImageAsset,
    upsert: upsertImageAssets,
    version: imageAssetVersion,
  } = useWorkspaceImageAssetStore();
  let imageInputRef = useRef<HTMLInputElement | null>(null);
  let previousWorkspaceBackendRef = useRef<WorkspaceBackend | null>(null);

  useEffect(() => {
    let previousBackend = previousWorkspaceBackendRef.current;
    if (previousBackend && previousBackend.id != workspaceBackend?.id) {
      removeWorkspaceImageQueries(queryClient, previousBackend);
    }
    previousWorkspaceBackendRef.current = workspaceBackend;
    clearImageAssets();
  }, [clearImageAssets, queryClient, workspaceBackend]);

  let loadImageAsset = useCallback(
    (path: string) => {
      if (!isImageFileName(path)) return Promise.resolve(null);

      let cached = getImageAsset(path);
      if (cached) return Promise.resolve(cached);

      let backend = workspaceBackendRef.current;
      if (!backend) return Promise.resolve(null);

      return readWorkspaceImageBytes(queryClient, backend, path)
        .then((bytes) => {
          if (!bytes) return null;
          if (workspaceBackendRef.current?.id != backend.id) return null;
          let asset = createWorkspaceImageAssetFromBytes(path, bytes);
          upsertImageAssets([asset]);
          return asset;
        })
        .catch(() => null);
    },
    [getImageAsset, queryClient, upsertImageAssets, workspaceBackendRef],
  );

  let resolveImageSource = useMemo<LiveMdImageSourceResolver>(() => {
    return (source) => {
      if (singleFileSource) return source;
      let imagePath = resolveMarkdownImagePath(source, editorDocument.path);
      if (!imagePath) return source;
      let asset = getImageAsset(imagePath);
      if (asset) return asset.url;
      void loadImageAsset(imagePath);
      return source;
    };
  }, [editorDocument.path, imageAssetVersion, loadImageAsset, singleFileSource]);

  let insertImageFiles = useCallback(
    async (files: File[], options: { position?: number; view?: EditorView } = {}) => {
      if (singleFileSourceRef.current) return;

      let file = selectedFileRef.current;
      let backend = workspaceBackendRef.current;
      if (!backend?.createImageAsset || !file) return;

      let imageFiles = files.filter(isImageFile);
      if (!imageFiles.length) return;

      setBusy(true);
      setErrorMessage("");

      try {
        let insertedAssets: Array<WorkspaceImageAsset & { markdownReference: string }> = [];
        for (let imageFile of imageFiles) {
          let asset = await backend.createImageAsset(file.path, imageFile);
          insertedAssets.push({
            ...asset,
            url: URL.createObjectURL(imageFile),
          });
        }

        upsertImageAssets(insertedAssets);
        insertImageMarkdown(
          options.view ?? editorElementRef.current?.view ?? null,
          insertedAssets,
          options.position,
        );
      } catch (error) {
        setErrorMessage(errorToMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [
      editorElementRef,
      selectedFileRef,
      setBusy,
      setErrorMessage,
      singleFileSourceRef,
      upsertImageAssets,
      workspaceBackendRef,
    ],
  );

  let handleEditorImageFiles = useCallback(
    ({ files, position, view }: LiveMdImageFilesInput) => {
      void insertImageFiles(files, { position, view });
    },
    [insertImageFiles],
  );

  let imagePlugin = useMemo<LiveMdPlugin>(
    () =>
      liveMdImageAssets({
        onFiles: handleEditorImageFiles,
        resolve: resolveImageSource,
      }),
    [handleEditorImageFiles, resolveImageSource],
  );

  let handleImageInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      let files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      void insertImageFiles(files);
    },
    [insertImageFiles],
  );

  let resolveImageAssetFile = useCallback(
    async (path: string) => {
      if (singleFileSourceRef.current) return null;
      let cached = getImageAsset(path);
      if (cached) return cached.file;
      return (await loadImageAsset(path))?.file ?? null;
    },
    [getImageAsset, loadImageAsset, singleFileSourceRef],
  );

  return {
    canInsertImage: Boolean(
      !singleFileSource && workspaceBackend?.createImageAsset && selectedFile,
    ),
    imageInputRef,
    imagePlugin,
    handleImageInputChange,
    resolveImageAssetFile,
  };
}
