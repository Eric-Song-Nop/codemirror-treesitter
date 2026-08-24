// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type {
  CreateWorkspaceAgentRunHost,
  WorkspaceAgentHostRefs,
} from "@/lib/agent/adapters/workspace/run-host";
import { useWorkspaceAgentHost } from "./useWorkspaceAgentHost";

const { createWorkspaceAgentRunHost } = vi.hoisted(() => ({
  createWorkspaceAgentRunHost: vi.fn(),
}));

vi.mock("@/lib/agent/adapters/workspace/run-host", () => ({
  createWorkspaceAgentRunHost,
}));

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

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
  vi.clearAllMocks();
});

describe("useWorkspaceAgentHost", () => {
  it("returns a stable factory that reads the binding refs when each run starts", async () => {
    let refs = fakeRefs();
    let factories: CreateWorkspaceAgentRunHost[] = [];
    let host = { getContext: () => ({ workspace: { id: "local:test" } }) };
    createWorkspaceAgentRunHost.mockReturnValue(host);
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);

    function Harness() {
      factories.push(useWorkspaceAgentHost(refs));
      return null;
    }

    await act(async () => root?.render(<Harness />));
    await act(async () => root?.render(<Harness />));
    expect(factories[1]).toBe(factories[0]);
    expect(factories[0]!()).toBe(host);
    expect(createWorkspaceAgentRunHost).toHaveBeenCalledWith(refs);
  });
});

function fakeRefs(): WorkspaceAgentHostRefs {
  let ref = { current: null };
  return {
    activeDocumentGenerationRef: { current: 0 },
    collabDocumentRef: ref,
    dirtyRef: { current: false },
    documentTargetGenerationRef: { current: 0 },
    editorElementRef: ref,
    editVersionRef: { current: 0 },
    selectedFileRef: ref,
    selectedFileSourceRef: ref,
    singleFileSourceRef: ref,
    workspaceRuntimeRef: ref,
  };
}
