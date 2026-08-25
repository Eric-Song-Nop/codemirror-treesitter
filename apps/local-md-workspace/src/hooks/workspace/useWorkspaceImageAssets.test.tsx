// @vitest-environment happy-dom

import { act, useEffect, useRef, type ChangeEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EditorView } from "@codemirror/view";
import type { LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import type { EditorDocument, SingleFileSource } from "@/lib/workspace/types";
import type { CreatedWorkspaceImageNode, MarkdownFileNode } from "@/lib/workspace/tree";
import type { WorkspaceAssetPort, WorkspaceRuntime } from "@/lib/workspace/runtime/types";
import { createMemoryWorkspaceRuntime } from "@/test/memory-workspace-runtime";
import { useWorkspaceImageAssets } from "./useWorkspaceImageAssets";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type ImageAssetsApi = ReturnType<typeof useWorkspaceImageAssets>;

let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;
let originalRevokeObjectUrl: typeof URL.revokeObjectURL | undefined;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let activeQueryClient: QueryClient | null = null;
let currentApi: ImageAssetsApi | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  originalCreateObjectUrl = URL.createObjectURL?.bind(URL);
  originalRevokeObjectUrl = URL.revokeObjectURL?.bind(URL);
});

beforeEach(() => {
  let nextUrlId = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:test-${(nextUrlId += 1)}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  activeQueryClient?.clear();
  activeQueryClient = null;
  currentApi = null;
  container?.remove();
  container = null;
  restoreUrlObjectMethods();
  vi.restoreAllMocks();
});

describe("useWorkspaceImageAssets", () => {
  it("refetches image bytes after the workspace image asset cache is reset", async () => {
    let readWorkspaceImage = vi
      .fn(async (_path: string) => new Uint8Array())
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
      .mockResolvedValueOnce(new Uint8Array([4, 5, 6]));
    let firstBackend = createTestRuntime("workspace-a", readWorkspaceImage);
    let secondBackend = createTestRuntime(
      "workspace-b",
      vi.fn(async (_path: string) => new Uint8Array([9])),
    );

    await renderImageAssetsHook(firstBackend);
    let firstFile = await resolveImageAssetFile("images/photo.png");

    expect(readWorkspaceImage).toHaveBeenCalledTimes(1);
    await expect(fileBytes(firstFile)).resolves.toEqual([1, 2, 3]);

    await renderImageAssetsHook(secondBackend);
    await renderImageAssetsHook(firstBackend);
    let secondFile = await resolveImageAssetFile("images/photo.png");

    expect(readWorkspaceImage).toHaveBeenCalledTimes(2);
    await expect(fileBytes(secondFile)).resolves.toEqual([4, 5, 6]);
  });

  it("rolls back an upload after an A to B to A document transition", async () => {
    let createdAsset = createImageNode("photo.png", "notes/assets/photo.png");
    let upload = createDeferred<CreatedWorkspaceImageNode>();
    let deleteFile = vi.fn(async () => {});
    let createImageAsset = vi.fn(async () => upload.promise);
    let backend = createTestRuntime("workspace-a", undefined, {
      createImageAsset,
      deleteFile,
    });
    let otherDeleteFile = vi.fn(async () => {});
    let otherBackend = createTestRuntime("workspace-b", undefined, {
      createImageAsset: vi.fn(),
      deleteFile: otherDeleteFile,
    });
    let editorView = createTestEditorView();

    await renderImageAssetsHook({
      imageSelectionKey: 1,
      editorView,
      selectedFile: testSelectedFile,
      workspaceRuntime: backend,
    });
    void startImageUpload([createdAsset.file]);
    expect(createImageAsset).toHaveBeenCalledWith(testSelectedFile.path, createdAsset.file);

    await renderImageAssetsHook({
      imageSelectionKey: 2,
      editorView,
      selectedFile: otherSelectedFile,
      workspaceRuntime: otherBackend,
    });
    await renderImageAssetsHook({
      imageSelectionKey: 3,
      editorView,
      selectedFile: testSelectedFile,
      workspaceRuntime: backend,
    });

    await act(async () => upload.resolve(createdAsset));
    await waitFor(
      () => deleteFile.mock.calls.length > 0 || editorView.dispatch.mock.calls.length > 0,
    );

    expect(deleteFile).toHaveBeenCalledWith(createdAsset.path);
    expect(otherDeleteFile).not.toHaveBeenCalled();
    expect(editorView.dispatch).not.toHaveBeenCalled();
  });

  it("rolls back an earlier batch asset and object URL when a later upload fails", async () => {
    let firstAsset = createImageNode("first.png", "notes/assets/first.png");
    let secondFile = new File([new Uint8Array([4, 5, 6])], "second.png", {
      type: "image/png",
    });
    let uploadError = new Error("second image upload failed");
    let createImageAsset = vi
      .fn<(markdownPath: string, file: File) => Promise<CreatedWorkspaceImageNode>>()
      .mockResolvedValueOnce(firstAsset)
      .mockRejectedValueOnce(uploadError);
    let deleteFile = vi.fn(async () => {});
    let setBusy = vi.fn();
    let setErrorMessage = vi.fn();
    let backend = createTestRuntime("workspace-a", undefined, {
      createImageAsset,
      deleteFile,
    });
    let editorView = createTestEditorView();

    await renderImageAssetsHook({
      imageSelectionKey: 1,
      editorView,
      selectedFile: testSelectedFile,
      setBusy,
      setErrorMessage,
      workspaceRuntime: backend,
    });
    void startImageUpload([firstAsset.file, secondFile]);
    await waitFor(() => setBusy.mock.calls.some(([busy]) => busy === false));

    expect(deleteFile).toHaveBeenCalledWith(firstAsset.path);
    let revokedUrls = (URL.revokeObjectURL as ReturnType<typeof vi.fn>).mock.calls;
    expect(revokedUrls).toContainEqual(["blob:test-1"]);
    expect(editorView.dispatch).not.toHaveBeenCalled();
    expect(setErrorMessage).toHaveBeenLastCalledWith(uploadError.message);
  });

  it("exhausts batch cleanup when one asset deletion fails", async () => {
    let firstAsset = createImageNode("first.png", "notes/assets/first.png");
    let secondAsset = createImageNode("second.png", "notes/assets/second.png");
    let thirdFile = new File([new Uint8Array([7, 8, 9])], "third.png", {
      type: "image/png",
    });
    let uploadError = new Error("third image upload failed");
    let rollbackError = new Error("first image cleanup failed");
    let createImageAsset = vi
      .fn<(markdownPath: string, file: File) => Promise<CreatedWorkspaceImageNode>>()
      .mockResolvedValueOnce(firstAsset)
      .mockResolvedValueOnce(secondAsset)
      .mockRejectedValueOnce(uploadError);
    let deleteFile = vi.fn(async (path: string) => {
      if (path == firstAsset.path) throw rollbackError;
    });
    let setBusy = vi.fn();
    let setErrorMessage = vi.fn();
    let backend = createTestRuntime("workspace-a", undefined, {
      createImageAsset,
      deleteFile,
    });
    let editorView = createTestEditorView();

    await renderImageAssetsHook({
      imageSelectionKey: 1,
      editorView,
      selectedFile: testSelectedFile,
      setBusy,
      setErrorMessage,
      workspaceRuntime: backend,
    });
    void startImageUpload([firstAsset.file, secondAsset.file, thirdFile]);
    await waitFor(() => setBusy.mock.calls.some(([busy]) => busy === false));

    expect(deleteFile.mock.calls.map(([path]) => path)).toEqual([
      secondAsset.path,
      firstAsset.path,
    ]);
    let revokedUrls = (URL.revokeObjectURL as ReturnType<typeof vi.fn>).mock.calls;
    expect(revokedUrls).toEqual([["blob:test-1"], ["blob:test-2"]]);
    expect(editorView.dispatch).not.toHaveBeenCalled();
    expect(setErrorMessage).toHaveBeenLastCalledWith(
      "Image upload failed and created assets could not be fully cleaned up.",
    );
  });

  it("rolls back an upload that finishes after the hook unmounts", async () => {
    let createdAsset = createImageNode("photo.png", "notes/assets/photo.png");
    let upload = createDeferred<CreatedWorkspaceImageNode>();
    let deleteFile = vi.fn(async () => {});
    let backend = createTestRuntime("workspace-a", undefined, {
      createImageAsset: vi.fn(async () => upload.promise),
      deleteFile,
    });
    let editorView = createTestEditorView();

    await renderImageAssetsHook({ editorView, workspaceRuntime: backend });
    void startImageUpload([createdAsset.file]);
    act(() => {
      root?.unmount();
      root = null;
    });
    await act(async () => upload.resolve(createdAsset));
    await waitFor(() => deleteFile.mock.calls.length == 1);

    expect(deleteFile).toHaveBeenCalledWith(createdAsset.path);
    expect(editorView.dispatch).not.toHaveBeenCalled();
  });

  it("commits a successful batch once to the captured editor view", async () => {
    let createdAsset = createImageNode("photo.png", "notes/assets/photo.png");
    let deleteFile = vi.fn(async () => {});
    let backend = createTestRuntime("workspace-a", undefined, {
      createImageAsset: vi.fn(async () => createdAsset),
      deleteFile,
    });
    let editorView = createTestEditorView();

    await renderImageAssetsHook({ editorView, workspaceRuntime: backend });
    let upload = startImageUpload([createdAsset.file]);
    await act(async () => upload);

    expect(editorView.dispatch).toHaveBeenCalledOnce();
    expect(editorView.focus).toHaveBeenCalledOnce();
    expect(deleteFile).not.toHaveBeenCalled();
    expect((URL.revokeObjectURL as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
  });
});

type RenderImageAssetsHookOptions = {
  editorView?: TestEditorView | null;
  imageSelectionKey?: number;
  selectedFile?: MarkdownFileNode;
  setBusy?: (busy: boolean) => void;
  setErrorMessage?: (message: string) => void;
  workspaceRuntime: WorkspaceRuntime;
};

type TestEditorView = EditorView & {
  dispatch: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
};

async function renderImageAssetsHook(
  workspaceRuntimeOrOptions: WorkspaceRuntime | RenderImageAssetsHookOptions,
) {
  if (!container) {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  }

  let queryClient = activeQueryClient ?? new QueryClient();
  activeQueryClient = queryClient;
  let options =
    "workspaceRuntime" in workspaceRuntimeOrOptions
      ? workspaceRuntimeOrOptions
      : { workspaceRuntime: workspaceRuntimeOrOptions };

  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ImageAssetsHarness
          editorView={options.editorView ?? null}
          imageSelectionKey={options.imageSelectionKey ?? 0}
          onApi={(api) => (currentApi = api)}
          selectedFile={options.selectedFile ?? testSelectedFile}
          setBusy={options.setBusy ?? (() => {})}
          setErrorMessage={options.setErrorMessage ?? (() => {})}
          workspaceRuntime={options.workspaceRuntime}
        />
      </QueryClientProvider>,
    );
  });
}

function ImageAssetsHarness({
  editorView,
  imageSelectionKey,
  onApi,
  selectedFile,
  setBusy,
  setErrorMessage,
  workspaceRuntime,
}: {
  editorView: TestEditorView | null;
  imageSelectionKey: number;
  onApi: (api: ImageAssetsApi) => void;
  selectedFile: MarkdownFileNode;
  setBusy: (busy: boolean) => void;
  setErrorMessage: (message: string) => void;
  workspaceRuntime: WorkspaceRuntime;
}) {
  let editorElementRef = useRef<LiveMdEditorElement | null>(null);
  let imageUploadAbortRef = useRef<AbortController | null>(null);
  let selectedFileSourceRef = useRef<WorkspaceRuntime | null>(workspaceRuntime);
  let selectedFileRef = useRef<MarkdownFileNode | null>(selectedFile);
  let singleFileSourceRef = useRef<SingleFileSource | null>(null);
  let workspaceRuntimeRef = useRef<WorkspaceRuntime | null>(workspaceRuntime);

  editorElementRef.current = editorView
    ? ({ view: editorView } as unknown as LiveMdEditorElement)
    : null;
  selectedFileSourceRef.current = workspaceRuntime;
  selectedFileRef.current = selectedFile;
  singleFileSourceRef.current = null;
  workspaceRuntimeRef.current = workspaceRuntime;

  useEffect(() => {
    imageUploadAbortRef.current?.abort();
    imageUploadAbortRef.current = null;
  }, [imageSelectionKey]);

  let hookOptions = {
    editorDocument: { ...testEditorDocument, path: selectedFile.path },
    editorElementRef,
    imageUploadAbortRef,
    selectedFile,
    selectedFileSourceRef,
    selectedFileRef,
    setBusy,
    setErrorMessage,
    singleFileSource: null,
    singleFileSourceRef,
    workspaceRuntime,
    workspaceRuntimeRef,
  };
  let api = useWorkspaceImageAssets(hookOptions);

  useEffect(() => {
    onApi(api);
  }, [api, onApi]);

  return null;
}

async function resolveImageAssetFile(path: string) {
  let file: File | null = null;
  await act(async () => {
    file = (await currentImageAssetsApi().resolveImageAssetFile(path)) ?? null;
  });
  expect(file).not.toBeNull();
  return file!;
}

function currentImageAssetsApi() {
  if (!currentApi) throw new Error("Image assets hook API was not mounted.");
  return currentApi;
}

async function fileBytes(file: File) {
  return [...new Uint8Array(await file.arrayBuffer())];
}

function createTestRuntime(
  id: string,
  readBytes: WorkspaceAssetPort["read"] = async () => new Uint8Array(),
  overrides: {
    createImageAsset?: WorkspaceAssetPort["create"];
    deleteFile?: (path: string) => Promise<void>;
  } = {},
): WorkspaceRuntime {
  let runtime = createMemoryWorkspaceRuntime([], { id, name: id });
  let createAsset = runtime.assets.create.bind(runtime.assets);
  let deleteAsset = runtime.assets.delete.bind(runtime.assets);
  runtime.assets = {
    ...runtime.assets,
    create: overrides.createImageAsset ?? createAsset,
    delete: overrides.deleteFile
      ? async (path) => {
          await overrides.deleteFile!(path);
          return { status: "applied" };
        }
      : deleteAsset,
    read: readBytes,
  };
  return runtime;
}

function startImageUpload(files: File[]) {
  let input = { files, value: "selected" } as unknown as HTMLInputElement;
  let upload: Promise<void> | undefined;
  act(() => {
    upload = currentImageAssetsApi().handleImageInputChange({
      currentTarget: input,
    } as ChangeEvent<HTMLInputElement>);
  });
  expect(input.value).toBe("");
  return upload;
}

function createImageNode(name: string, path: string): CreatedWorkspaceImageNode {
  return {
    file: new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" }),
    markdownReference: `assets/${name}`,
    name,
    path,
  };
}

function createTestEditorView(): TestEditorView {
  return {
    dispatch: vi.fn(),
    focus: vi.fn(),
    state: {
      doc: {
        length: 0,
        sliceString: () => "",
      },
      selection: { main: { from: 0, to: 0 } },
    },
  } as unknown as TestEditorView;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

function restoreUrlObjectMethods() {
  restoreUrlObjectMethod("createObjectURL", originalCreateObjectUrl);
  restoreUrlObjectMethod("revokeObjectURL", originalRevokeObjectUrl);
}

function restoreUrlObjectMethod<T extends "createObjectURL" | "revokeObjectURL">(
  method: T,
  value: (typeof URL)[T] | undefined,
) {
  if (value) {
    Object.defineProperty(URL, method, {
      configurable: true,
      value,
    });
    return;
  }
  delete URL[method];
}

const testEditorDocument: EditorDocument = {
  path: "notes/doc.md",
  value: "",
  version: 0,
};

const testSelectedFile: MarkdownFileNode = {
  kind: "file",
  name: "doc.md",
  path: "notes/doc.md",
};

const otherSelectedFile: MarkdownFileNode = {
  kind: "file",
  name: "other.md",
  path: "notes/other.md",
};
