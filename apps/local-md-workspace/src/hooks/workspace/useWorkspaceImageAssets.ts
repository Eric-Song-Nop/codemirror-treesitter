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
import type {
  ActiveDocumentSource,
  EditorDocument,
  SingleFileSource,
  WorkspaceImageAsset,
} from "@/lib/workspace/types";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";

type UseWorkspaceImageAssetsOptions = {
  documentTargetGenerationRef: RefObject<number>;
  editorDocument: EditorDocument;
  editorElementRef: RefObject<LiveMdEditorElement | null>;
  selectedFile: MarkdownFileNode | null;
  selectedFileSourceRef: RefObject<ActiveDocumentSource | null>;
  selectedFileRef: RefObject<MarkdownFileNode | null>;
  setBusy: (busy: boolean) => void;
  setErrorMessage: (message: string) => void;
  singleFileSource: SingleFileSource | null;
  singleFileSourceRef: RefObject<SingleFileSource | null>;
  workspaceRuntime: WorkspaceRuntime | null;
  workspaceRuntimeRef: RefObject<WorkspaceRuntime | null>;
};

export function useWorkspaceImageAssets({
  documentTargetGenerationRef,
  editorDocument,
  editorElementRef,
  selectedFile,
  selectedFileSourceRef,
  selectedFileRef,
  setBusy,
  setErrorMessage,
  singleFileSource,
  singleFileSourceRef,
  workspaceRuntime,
  workspaceRuntimeRef,
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
  let previousWorkspaceRuntimeRef = useRef<WorkspaceRuntime | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let previousRuntime = previousWorkspaceRuntimeRef.current;
    if (previousRuntime && previousRuntime.identity.id != workspaceRuntime?.identity.id) {
      removeWorkspaceImageQueries(queryClient, previousRuntime);
    }
    previousWorkspaceRuntimeRef.current = workspaceRuntime;
    clearImageAssets();
  }, [clearImageAssets, queryClient, workspaceRuntime]);

  let loadImageAsset = useCallback(
    (path: string) => {
      if (!isImageFileName(path)) return Promise.resolve(null);

      let cached = getImageAsset(path);
      if (cached) return Promise.resolve(cached);

      let runtime = workspaceRuntimeRef.current;
      if (!runtime) return Promise.resolve(null);

      return readWorkspaceImageBytes(queryClient, runtime, path)
        .then((bytes) => {
          if (!bytes) return null;
          if (workspaceRuntimeRef.current?.identity.id != runtime.identity.id) return null;
          let asset = createWorkspaceImageAssetFromBytes(path, bytes);
          upsertImageAssets([asset]);
          return asset;
        })
        .catch(() => null);
    },
    [getImageAsset, queryClient, upsertImageAssets, workspaceRuntimeRef],
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
      let runtime = workspaceRuntimeRef.current;
      let view = options.view ?? editorElementRef.current?.view ?? null;
      if (!runtime || selectedFileSourceRef.current !== runtime || !file || !view) {
        return;
      }

      let imageFiles = files.filter(isImageFile);
      if (!imageFiles.length) return;

      let targetGeneration = documentTargetGenerationRef.current;
      let targetIsActive = () =>
        mountedRef.current &&
        documentTargetGenerationRef.current == targetGeneration &&
        editorElementRef.current?.view === view &&
        selectedFileSourceRef.current === runtime &&
        workspaceRuntimeRef.current === runtime &&
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
          let asset = await runtime.assets.create(file.path, imageFile);
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
          : await rollbackPendingImageAssets(runtime, createdAssets);
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
      selectedFileSourceRef,
      selectedFileRef,
      setBusy,
      setErrorMessage,
      singleFileSourceRef,
      upsertImageAssets,
      workspaceRuntimeRef,
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
    canInsertImage: Boolean(!singleFileSource && workspaceRuntime && selectedFile),
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

async function rollbackPendingImageAssets(runtime: WorkspaceRuntime, assets: PendingImageAsset[]) {
  let errors = revokePendingImageAssetUrls(assets);
  let deleteResults = await Promise.allSettled(
    assets.toReversed().map((asset) => runtime.assets.delete(asset.path)),
  );
  for (let result of deleteResults) {
    if (result.status == "rejected") {
      errors.push(result.reason);
    } else if (result.value.status != "applied") {
      errors.push(new Error(`Image cleanup ended with ${result.value.status}.`));
    }
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
