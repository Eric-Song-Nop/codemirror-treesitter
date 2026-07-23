// @vitest-environment happy-dom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DebouncedTask } from "@/lib/scheduling/debounced-task";
import type { SourceAutoSaveTask } from "@/lib/workspace/types";
import { useWorkspacePersistenceLifecycle } from "./useWorkspacePersistenceLifecycle";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type TestDocument = {
  dispose: () => Promise<void>;
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe("useWorkspacePersistenceLifecycle", () => {
  it.each([
    ["pagehide", () => window.dispatchEvent(new Event("pagehide"))],
    [
      "hidden visibility",
      () => {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      },
    ],
  ])("flushes collaboration and source persistence on %s", async (_name, dispatch) => {
    let sourceTask = createTestTask();
    let collabDocument = createTestDocument();
    let flushCollabDocument = vi.fn(async () => {});

    await renderLifecycle({ collabDocument, flushCollabDocument, sourceTask });
    await act(async () => dispatch());

    expect(flushCollabDocument).toHaveBeenCalledWith(collabDocument);
    expect(sourceTask.flush).toHaveBeenCalledOnce();
  });

  it("still flushes source persistence when collaboration persistence fails", async () => {
    let sourceTask = createTestTask();
    let setErrorMessage = vi.fn();

    await renderLifecycle({
      collabDocument: createTestDocument(),
      flushCollabDocument: vi.fn(async () => {
        throw new Error("collaboration persistence failed");
      }),
      setErrorMessage,
      sourceTask,
    });
    await act(async () => window.dispatchEvent(new Event("pagehide")));

    expect(sourceTask.flush).toHaveBeenCalledOnce();
    expect(setErrorMessage).toHaveBeenCalledWith("collaboration persistence failed");
  });

  it("flushes before disposing persistence resources on unmount", async () => {
    let flushCompleted = createDeferred<void>();
    let sourceTask = createTestTask(() => flushCompleted.promise);
    let collabDocument = createTestDocument();
    let collabSyncCleanup = vi.fn();

    await renderLifecycle({ collabDocument, collabSyncCleanup, sourceTask });
    act(() => {
      root?.unmount();
      root = null;
    });

    expect(sourceTask.flush).toHaveBeenCalledOnce();
    expect(sourceTask.dispose).not.toHaveBeenCalled();
    expect(collabDocument.dispose).not.toHaveBeenCalled();
    expect(collabSyncCleanup).toHaveBeenCalledOnce();

    await act(async () => flushCompleted.resolve());

    expect(sourceTask.dispose).toHaveBeenCalledOnce();
    expect(collabDocument.dispose).toHaveBeenCalledOnce();
  });
});

async function renderLifecycle({
  collabDocument = null,
  collabSyncCleanup = vi.fn(),
  flushCollabDocument = vi.fn(async () => {}),
  setErrorMessage = vi.fn(),
  sourceTask = null,
}: {
  collabDocument?: TestDocument | null;
  collabSyncCleanup?: () => void;
  flushCollabDocument?: (document: TestDocument) => Promise<void>;
  setErrorMessage?: (message: string) => void;
  sourceTask?: DebouncedTask | null;
}) {
  await act(async () => {
    root?.render(
      <LifecycleHarness
        collabDocument={collabDocument}
        collabSyncCleanup={collabSyncCleanup}
        flushCollabDocument={flushCollabDocument}
        setErrorMessage={setErrorMessage}
        sourceTask={sourceTask}
      />,
    );
  });
}

function LifecycleHarness({
  collabDocument,
  collabSyncCleanup,
  flushCollabDocument,
  setErrorMessage,
  sourceTask,
}: {
  collabDocument: TestDocument | null;
  collabSyncCleanup: () => void;
  flushCollabDocument: (document: TestDocument) => Promise<void>;
  setErrorMessage: (message: string) => void;
  sourceTask: DebouncedTask | null;
}) {
  let autoSaveTaskRef = useRef<SourceAutoSaveTask | null>(
    sourceTask ? { key: "local", task: sourceTask } : null,
  );
  let collabDocumentRef = useRef(collabDocument);
  let collabSyncCleanupRef = useRef(collabSyncCleanup);

  useWorkspacePersistenceLifecycle({
    autoSaveTaskRef,
    collabDocumentRef,
    collabSyncCleanupRef,
    flushCollabDocument,
    setErrorMessage,
  });
  return null;
}

function createTestDocument(): TestDocument {
  return {
    dispose: vi.fn(async () => {}),
  };
}

function createTestTask(flush: () => Promise<void> = async () => {}): DebouncedTask {
  return {
    cancel: vi.fn(),
    dispose: vi.fn(),
    flush: vi.fn(flush),
    pending: vi.fn(() => true),
    schedule: vi.fn(),
  };
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
