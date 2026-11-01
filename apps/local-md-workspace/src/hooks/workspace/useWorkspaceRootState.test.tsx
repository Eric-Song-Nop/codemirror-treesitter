// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  createWorkspaceAppStore,
  publishEditorDocumentValue,
  type WorkspaceAppStore,
} from "@/app/workspace-store";
import { useWorkspaceRootState } from "./useWorkspaceRootState";

type ReactActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("useWorkspaceRootState", () => {
  it("does not re-render the workspace root across save, busy, error, or typing updates", async () => {
    let store = createWorkspaceAppStore();
    let renders = await renderRootProbe(store);
    let initial = renders.count;

    act(() => {
      let setField: ReturnType<WorkspaceAppStore["getState"]>["setField"] = (key, update) =>
        store.getState().setField(key, update);
      setField("saveState", "pending");
      setField("saveState", "saving");
      setField("saveState", "saved");
      setField("busy", true);
      setField("busy", false);
      setField("errorMessage", "Save failed");
      setField("retryLoadPath", "a.md");
      setField("dropboxConnecting", true);
      setField("workspacePermission", "denied");
      setField("openingDocument", { path: "b.md" });
      publishEditorDocumentValue(store, { path: "", value: "typed" });
      publishEditorDocumentValue(store, { path: "", value: "typed more" });
    });

    expect(renders.count).toBe(initial);

    act(() => store.getState().setField("sidebarOpen", (open) => !open));
    expect(renders.count).toBe(initial + 1);
  });
});

async function renderRootProbe(store: WorkspaceAppStore) {
  let renders = { count: 0 };
  function RootProbe() {
    useWorkspaceRootState(store);
    renders.count += 1;
    return null;
  }
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(<RootProbe />);
  });
  return renders;
}
