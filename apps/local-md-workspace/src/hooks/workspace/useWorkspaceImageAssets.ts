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
  documentTargetGenerationRef: RefObject<number>;
  editorDocument: EditorDocument;
  editorElementRef: RefObject<LiveMdEditorElement | null>;
  selectedFile: MarkdownFileNode | null;
  selectedFileBackendRef: RefObject<WorkspaceBackend | null>;
  selectedFileRef: RefObject<MarkdownFileNode | null>;
  setBusy: (busy: boolean) => void;
  setErrorMessage: (message: string) => void;
  singleFileSource: SingleFileSource | null;
  singleFileSourceRef: RefObject<SingleFileSource | null>;
  workspaceBackend: WorkspaceBackend | null;
  workspaceBackendRef: RefObject<WorkspaceBackend | null>;
};

export function useWorkspaceImageAssets({
  documentTargetGenerationRef,
  editorDocument,
  editorElementRef,
  selectedFile,
  selectedFileBackendRef,
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
  let mountedRef = useRef(false);
  let previousWorkspaceBackendRef = useRef<WorkspaceBackend | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      let backend = selectedFileBackendRef.current;
      let view = options.view ?? editorElementRef.current?.view ?? null;
      if (!backend?.createImageAsset || workspaceBackendRef.current !== backend || !file || !view) {
        return;
      }

      let imageFiles = files.filter(isImageFile);
      if (!imageFiles.length) return;

      let targetGeneration = documentTargetGenerationRef.current;
      let targetIsActive = () =>
        mountedRef.current &&
        documentTargetGenerationRef.current == targetGeneration &&
        editorElementRef.current?.view === view &&
        selectedFileBackendRef.current === backend &&
        workspaceBackendRef.current === backend &&
        selectedFileRef.current === file &&
        !singleFileSourceRef.current;

      setBusy(true);
      setErrorMessage("");

      let createdAssets: PendingImageAsset[] = [];
      let referencesInserted = false;
      try {
        let insertedAssets: Array<WorkspaceImageAsset & { markdownReference: string }> = [];
        for (let imageFile of imageFiles) {
          if (!targetIsActive()) throw staleImageUpload;
          let asset = await backend.createImageAsset(file.path, imageFile);
          let pendingAsset: PendingImageAsset = { path: asset.path };
          createdAssets.push(pendingAsset);
          if (!targetIsActive()) throw staleImageUpload;

          let url = URL.createObjectURL(imageFile);
          pendingAsset.url = url;
          insertedAssets.push({
            ...asset,
            url,
          });
        }

        if (!targetIsActive()) throw staleImageUpload;
        insertImageMarkdown(view, insertedAssets, options.position);
        referencesInserted = true;
        upsertImageAssets(insertedAssets);
        createdAssets = [];
      } catch (error) {
        let stale = error === staleImageUpload || !targetIsActive();
        let rollbackErrors = referencesInserted
          ? revokePendingImageAssetUrls(createdAssets)
          : await rollbackPendingImageAssets(backend, createdAssets);
        let reportedError = error;
        if (rollbackErrors.length) {
          reportedError = new AggregateError(
            [error, ...rollbackErrors],
            "Image upload failed and created assets could not be fully cleaned up.",
            { cause: error },
          );
        }
        if (mountedRef.current && (!stale || rollbackErrors.length)) {
          setErrorMessage(errorToMessage(reportedError));
        }
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [
      documentTargetGenerationRef,
      editorElementRef,
      selectedFileBackendRef,
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
      return insertImageFiles(files);
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

const staleImageUpload = Symbol("stale image upload");

type PendingImageAsset = {
  path: string;
  url?: string;
};

async function rollbackPendingImageAssets(backend: WorkspaceBackend, assets: PendingImageAsset[]) {
  let errors = revokePendingImageAssetUrls(assets);
  let deleteResults = await Promise.allSettled(
    assets.toReversed().map((asset) => backend.deleteFile(asset.path)),
  );
  for (let result of deleteResults) {
    if (result.status == "rejected") errors.push(result.reason);
  }
  return errors;
}

function revokePendingImageAssetUrls(assets: PendingImageAsset[]) {
  let errors: unknown[] = [];
  for (let asset of assets) {
    if (!asset.url) continue;
    try {
      URL.revokeObjectURL(asset.url);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
