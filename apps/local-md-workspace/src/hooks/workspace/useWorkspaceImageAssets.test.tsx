// @vitest-environment happy-dom

import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import type { EditorDocument, SingleFileSource } from "@/lib/workspace/types";
import type { MarkdownFileNode, WorkspaceBackend } from "@/lib/workspace-backend";
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
    let firstBackend = createTestBackend("workspace-a", readWorkspaceImage);
    let secondBackend = createTestBackend(
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
});

async function renderImageAssetsHook(workspaceBackend: WorkspaceBackend) {
  if (!container) {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  }

  let queryClient = activeQueryClient ?? new QueryClient();
  activeQueryClient = queryClient;

  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ImageAssetsHarness
          onApi={(api) => (currentApi = api)}
          workspaceBackend={workspaceBackend}
        />
      </QueryClientProvider>,
    );
  });
}

function ImageAssetsHarness({
  onApi,
  workspaceBackend,
}: {
  onApi: (api: ImageAssetsApi) => void;
  workspaceBackend: WorkspaceBackend;
}) {
  let editorElementRef = useRef<LiveMdEditorElement | null>(null);
  let selectedFileRef = useRef<MarkdownFileNode | null>(testSelectedFile);
  let singleFileSourceRef = useRef<SingleFileSource | null>(null);
  let workspaceBackendRef = useRef<WorkspaceBackend | null>(workspaceBackend);

  selectedFileRef.current = testSelectedFile;
  singleFileSourceRef.current = null;
  workspaceBackendRef.current = workspaceBackend;

  let api = useWorkspaceImageAssets({
    editorDocument: testEditorDocument,
    editorElementRef,
    selectedFile: testSelectedFile,
    selectedFileRef,
    setBusy: () => {},
    setErrorMessage: () => {},
    singleFileSource: null,
    singleFileSourceRef,
    workspaceBackend,
    workspaceBackendRef,
  });

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

function createTestBackend(
  id: string,
  readBytes: NonNullable<WorkspaceBackend["readBytes"]>,
): WorkspaceBackend {
  return {
    id,
    kind: "local",
    name: id,
    createFile: async () => null,
    deleteFile: async () => {},
    readBytes,
    readFile: async () => "",
    readTree: async () => ({ children: [], kind: "directory", name: id, path: "" }),
    renameFile: async (_path, rawName) => rawName,
    writeFile: async () => {},
  };
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
