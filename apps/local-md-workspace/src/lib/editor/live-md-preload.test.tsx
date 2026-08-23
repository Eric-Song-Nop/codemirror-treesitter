// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
  LiveMdPreloadErrorProvider,
  useLiveMdPreload,
  type LiveMdPreloadState,
} from "./live-md-preload";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let currentState: LiveMdPreloadState | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  currentState = null;
});

describe("LiveMdPreloadErrorProvider", () => {
  it("keeps startup single-flight and recovers in-page after an explicit retry", async () => {
    let preload = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary WASM fetch failure"))
      .mockResolvedValueOnce(undefined);

    await renderProvider(preload);
    await waitFor(() => currentPreloadState().error.includes("temporary WASM fetch failure"));
    expect(preload).toHaveBeenCalledTimes(1);
    expect(currentPreloadState()).toMatchObject({ generation: 0, retrying: false });

    await act(async () => {
      await currentPreloadState().retry();
    });

    expect(preload).toHaveBeenCalledTimes(2);
    expect(currentPreloadState()).toMatchObject({ error: "", generation: 1, retrying: false });
  });
});

async function renderProvider(preload: () => Promise<void>) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <LiveMdPreloadErrorProvider preload={preload}>
        <PreloadStateHarness />
      </LiveMdPreloadErrorProvider>,
    );
  });
}

function PreloadStateHarness() {
  let state = useLiveMdPreload();
  useEffect(() => {
    currentState = state;
  }, [state]);
  return null;
}

function currentPreloadState() {
  if (!currentState) throw new Error("Preload state is unavailable.");
  return currentState;
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error("Timed out waiting for preload state.");
}
