// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Effect, Scope } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
  WorkspaceApplicationProvider,
  useWorkspaceApplication,
} from "./WorkspaceApplicationProvider.tsx";
import { createWorkspaceApplication, type WorkspaceApplication } from "./workspace-application.ts";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let applications: WorkspaceApplication[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  await Promise.all(applications.map((application) => application.dispose()));
  applications = [];
  vi.restoreAllMocks();
});

describe("workspace application", () => {
  it("disposes its managed runtime exactly once and returns the same promise", async () => {
    let application = createTestApplication();
    await application.runtime.context();
    let finalizations = 0;
    Effect.runSync(
      Scope.addFinalizer(
        application.runtime.scope,
        Effect.sync(() => {
          finalizations += 1;
        }),
      ),
    );
    let disposeRuntime = vi.spyOn(application.runtime, "dispose");

    let firstDisposal = application.dispose();
    let repeatedDisposal = application.dispose();

    expect(repeatedDisposal).toBe(firstDisposal);
    await firstDisposal;
    expect(disposeRuntime).toHaveBeenCalledOnce();
    expect(finalizations).toBe(1);

    expect(application.dispose()).toBe(firstDisposal);
    expect(disposeRuntime).toHaveBeenCalledOnce();
    expect(finalizations).toBe(1);
  });

  it("keeps the provided application identity stable through the StrictMode probe", async () => {
    let application = createTestApplication();
    let disposeRuntime = vi.spyOn(application.runtime, "dispose");
    let observedApplications: WorkspaceApplication[] = [];

    function Consumer() {
      observedApplications.push(useWorkspaceApplication());
      return null;
    }

    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <StrictMode>
          <WorkspaceApplicationProvider application={application}>
            <Consumer />
          </WorkspaceApplicationProvider>
        </StrictMode>,
      );
    });

    expect(observedApplications.length).toBeGreaterThan(1);
    expect(observedApplications.every((observed) => observed === application)).toBe(true);
    expect(disposeRuntime).not.toHaveBeenCalled();

    act(() => root?.unmount());
    root = null;
    expect(disposeRuntime).not.toHaveBeenCalled();
  });
});

function createTestApplication() {
  let application = createWorkspaceApplication();
  applications.push(application);
  return application;
}
