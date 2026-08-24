import { ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import type { ActiveWorkspaceDocumentSession } from "@/lib/workspace/document-session";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import {
  createWorkspaceDocumentSessionController,
  createWorkspaceDocumentSessionKernel,
  WorkspaceDocumentSessionCoordinator,
  type PreparedWorkspaceDocumentSession,
  type WorkspaceDocumentSessionController,
} from "./document-session-coordinator.ts";
import { createWorkspaceAppStore } from "./workspace-store.ts";

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("WorkspaceDocumentSessionCoordinator", () => {
  it("installs the latest document and disposes a stale candidate", async () => {
    let fixture = createFixture();
    let prepareA = deferred();
    let candidateA = fixture.candidate("A", "a.md", { prepareGate: prepareA });
    let candidateB = fixture.candidate("B", "b.md");

    let transitionA = transition(fixture.controller, candidateA);
    await vi.waitFor(() => expect(candidateA.prepareCalls).toBe(1));

    expect(await transition(fixture.controller, candidateB)).toBe(candidateB.session);
    prepareA.resolve();

    expect(await transitionA).toBeNull();
    expect(candidateA.activateCalls).toBe(0);
    expect(candidateA.disposeCalls).toBe(1);
    expect(fixture.controller.current()).toBe(candidateB.session);
    expect(fixture.store.getState().selectedFile).toBe(candidateB.file);
  });

  it("rechecks the latest intent after closing the active document", async () => {
    let fixture = createFixture();
    let releaseA = deferred();
    let candidateA = fixture.candidate("A", "a.md", { activeReleaseGate: releaseA });
    let candidateB = fixture.candidate("B", "b.md");
    let candidateC = fixture.candidate("C", "c.md");

    await transition(fixture.controller, candidateA);
    let transitionB = transition(fixture.controller, candidateB);
    await vi.waitFor(() => expect(candidateA.activeReleaseCalls).toBe(1));
    let transitionC = transition(fixture.controller, candidateC);

    releaseA.resolve();

    expect(await transitionB).toBeNull();
    expect(await transitionC).toBe(candidateC.session);
    expect(candidateB.activateCalls).toBe(0);
    expect(candidateB.disposeCalls).toBe(1);
    expect(fixture.controller.current()).toBe(candidateC.session);
  });

  it("keeps a replacement opening visible while closing the active document", async () => {
    let fixture = createFixture();
    await transition(fixture.controller, fixture.candidate("A", "a.md"));
    let replacement = fixture.controller.begin("Draft.md");

    await expect(fixture.controller.close(replacement)).resolves.toEqual({
      hadActiveSession: true,
    });
    expect(fixture.store.getState().openingDocument).toMatchObject({ path: "Draft.md" });

    fixture.controller.finish(replacement);
    expect(fixture.store.getState().openingDocument).toBeNull();
  });

  it("waits for pending cleanup and never installs a document during shutdown", async () => {
    let fixture = createFixture();
    let releaseA = deferred();
    let disposeB = deferred();
    let candidateA = fixture.candidate("A", "a.md", {
      activeReleaseError: new Error("release A failed"),
      activeReleaseGate: releaseA,
      disposeError: new Error("dispose A failed"),
    });
    let candidateB = fixture.candidate("B", "b.md", { disposeGate: disposeB });
    let candidateC = fixture.candidate("C", "c.md");

    await transition(fixture.controller, candidateA);
    let transitionB = transition(fixture.controller, candidateB);
    await vi.waitFor(() => expect(candidateA.activeReleaseCalls).toBe(1));
    let transitionC = transition(fixture.controller, candidateC);
    let transitions = Promise.allSettled([transitionB, transitionC]);
    await vi.waitFor(() => expect(candidateC.prepareCalls).toBe(1));

    let disposed = false;
    let disposal = fixture.startDisposal().then(() => {
      disposed = true;
    });
    releaseA.resolve();
    await vi.waitFor(() => expect(candidateB.disposeCalls).toBe(1));

    expect(disposed).toBe(false);
    expect(candidateB.activateCalls).toBe(0);
    expect(candidateC.activateCalls).toBe(0);

    disposeB.resolve();
    await transitions;
    await expect(disposal).resolves.toBeUndefined();

    expect(candidateA.disposeCalls).toBe(1);
    expect(candidateB.disposeCalls).toBe(1);
    expect(candidateC.disposeCalls).toBe(1);
    expect(fixture.controller.current()).toBeNull();
  });
});

type Deferred = ReturnType<typeof deferred>;

type CandidateProbe = {
  activeReleaseCalls: number;
  activateCalls: number;
  disposeCalls: number;
  file: MarkdownFileNode;
  prepare: () => Promise<PreparedWorkspaceDocumentSession>;
  prepareCalls: number;
  session: ActiveWorkspaceDocumentSession;
};

function createFixture() {
  let store = createWorkspaceAppStore();
  let kernel = createWorkspaceDocumentSessionKernel(store);
  let runtime = ManagedRuntime.make(WorkspaceDocumentSessionCoordinator.layer(kernel));
  let controller = createWorkspaceDocumentSessionController(kernel, (effect) =>
    runtime.runPromise(effect),
  );
  let gates = new Set<Deferred>();
  let disposal: Promise<void> | null = null;

  function candidate(
    id: string,
    path: string,
    options: {
      activeReleaseError?: Error;
      activeReleaseGate?: Deferred;
      disposeError?: Error;
      disposeGate?: Deferred;
      prepareGate?: Deferred;
    } = {},
  ): CandidateProbe {
    let file = { kind: "file" as const, name: path, path };
    let document = {
      docId: "document:" + id,
      path,
      value: "# " + id + "\\n",
    } as CollabDocumentState;
    let session = { epoch: id.codePointAt(0) ?? 0, file } as ActiveWorkspaceDocumentSession;
    let probe: CandidateProbe;
    for (let gate of [options.prepareGate, options.disposeGate, options.activeReleaseGate]) {
      if (gate) gates.add(gate);
    }

    let prepared: PreparedWorkspaceDocumentSession = {
      activate() {
        probe.activateCalls += 1;
        return {
          async release() {
            probe.activeReleaseCalls += 1;
            await options.activeReleaseGate?.promise;
            if (options.activeReleaseError) throw options.activeReleaseError;
          },
          retire() {},
          session,
        };
      },
      async dispose() {
        probe.disposeCalls += 1;
        await options.disposeGate?.promise;
        if (options.disposeError) throw options.disposeError;
      },
      view: { document, file, saveState: "saved", value: document.value },
    };

    return (probe = {
      activeReleaseCalls: 0,
      activateCalls: 0,
      disposeCalls: 0,
      file,
      async prepare() {
        probe.prepareCalls += 1;
        await options.prepareGate?.promise;
        return prepared;
      },
      prepareCalls: 0,
      session,
    });
  }

  let startDisposal = () => (disposal ??= runtime.dispose());
  cleanups.push(async () => {
    for (let gate of gates) gate.resolve();
    await startDisposal();
  });
  return { candidate, controller, startDisposal, store };
}

function transition(controller: WorkspaceDocumentSessionController, candidate: CandidateProbe) {
  return controller.transition({
    lease: controller.begin(candidate.file.path),
    prepare: candidate.prepare,
  });
}

function deferred() {
  let resolve!: () => void;
  let promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
