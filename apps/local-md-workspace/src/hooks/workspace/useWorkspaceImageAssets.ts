import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
} from "react";
import type { EditorView } from "@codemirror/view";
import type {
  LiveMdEditorElement,
  LiveMdImageSourceResolver,
} from "@codemirror-treesitter/live-md";
import type { LiveMdImageFilesInput } from "@/components/LiveMdEditor";
import { resolveMarkdownImagePath } from "@/lib/export/markdown-html";
import { errorToMessage } from "@/lib/workspace/errors";
import {
  createWorkspaceImageAssets,
  insertImageMarkdown,
  isImageFile,
  revokeImageAssetUrls,
} from "@/lib/workspace/images";
import type { EditorDocument, SingleFileSource, WorkspaceImageAsset } from "@/lib/workspace/types";
import type {
  MarkdownFileNode,
  WorkspaceBackend,
  WorkspaceImageNode,
} from "@/lib/workspace-backend";

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
  let imageAssetsRef = useRef(new Map<string, WorkspaceImageAsset>());
  let imageInputRef = useRef<HTMLInputElement | null>(null);
  let [imageAssetVersion, setImageAssetVersion] = useState(0);

  useEffect(
    () => () => {
      revokeImageAssetUrls(imageAssetsRef.current);
      imageAssetsRef.current = new Map();
    },
    [],
  );

  let replaceImageAssets = useCallback((nextAssets: WorkspaceImageAsset[]) => {
    revokeImageAssetUrls(imageAssetsRef.current);
    imageAssetsRef.current = new Map(nextAssets.map((asset) => [asset.path, asset]));
    setImageAssetVersion((version) => version + 1);
  }, []);

  let upsertImageAssets = useCallback((nextAssets: WorkspaceImageAsset[]) => {
    let assets = new Map(imageAssetsRef.current);
    for (let asset of nextAssets) {
      let previous = assets.get(asset.path);
      if (previous) URL.revokeObjectURL(previous.url);
      assets.set(asset.path, asset);
    }
    imageAssetsRef.current = assets;
    setImageAssetVersion((version) => version + 1);
  }, []);

  let resolveImageSource = useMemo<LiveMdImageSourceResolver>(() => {
    return (source) => {
      if (singleFileSource) return source;
      let imagePath = resolveMarkdownImagePath(source, editorDocument.path);
      if (!imagePath) return source;
      return imageAssetsRef.current.get(imagePath)?.url ?? source;
    };
  }, [editorDocument.path, imageAssetVersion, singleFileSource]);

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

  let handleImageInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      let files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      void insertImageFiles(files);
    },
    [insertImageFiles],
  );

  let resolveImageAssetFile = useCallback(
    (path: string) =>
      singleFileSourceRef.current ? null : (imageAssetsRef.current.get(path)?.file ?? null),
    [singleFileSourceRef],
  );

  let loadWorkspaceImageAssets = useCallback(
    async (nextImageNodes: WorkspaceImageNode[]) => {
      replaceImageAssets(await createWorkspaceImageAssets(nextImageNodes));
    },
    [replaceImageAssets],
  );

  return {
    canInsertImage: Boolean(
      !singleFileSource && workspaceBackend?.createImageAsset && selectedFile,
    ),
    imageInputRef,
    resolveImageSource,
    handleEditorImageFiles,
    handleImageInputChange,
    resolveImageAssetFile,
    replaceImageAssets: loadWorkspaceImageAssets,
  };
}
