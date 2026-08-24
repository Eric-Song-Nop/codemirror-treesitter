import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { CollabDocumentState } from "@/lib/collaboration/markdown-document";
import { createActiveWorkspaceDocumentSession } from "@/lib/workspace/document-session";
import type { MarkdownFileNode } from "@/lib/workspace/tree";
import { createMemoryWorkspaceRuntime } from "@/test/memory-workspace-runtime";
import {
  createWorkspaceDocumentSessionController,
  createWorkspaceDocumentSessionKernel,
  WorkspaceDocumentSessionCoordinator,
  type PreparedWorkspaceDocumentSession,
  type WorkspaceDocumentSessionController,
} from "./document-session-coordinator.ts";
import { createWorkspaceAppStore, type WorkspaceAppState } from "./workspace-store.ts";

describe("WorkspaceDocumentSessionCoordinator", () => {
  it("lets fast B supersede slow uncancelable A without publishing A", async () => {
    let fixture = createFixture();
    let candidateA = fixture.candidate("A", "a.md", { blockPrepare: true });
    let candidateB = fixture.candidate("B", "b.md");

    try {
      let leaseA = fixture.controller.begin(candidateA.file.path);
      let transitionA = settle(
        fixture.controller.transition({ lease: leaseA, prepare: candidateA.prepare }),
      );
      await candidateA.prepareStarted.promise;

      let leaseB = fixture.controller.begin(candidateB.file.path);
      let transitionB = await settle(
        fixture.controller.transition({ lease: leaseB, prepare: candidateB.prepare }),
      );

      expect(valueOf(transitionB)).toMatchObject({
        session: candidateB.session,
        status: "activated",
      });
      expect(fixture.controller.current()).toBe(candidateB.session);
      expect(fixture.store.getState()).toMatchObject({
        collabDocument: candidateB.document,
        editorDocument: { path: candidateB.file.path, value: candidateB.document.value },
        openingDocument: null,
        selectedFile: candidateB.file,
      });

      candidateA.releasePrepare.open();
      expect(valueOf(await transitionA)).toEqual({ status: "superseded" });

      expect(candidateA.activateCalls).toBe(0);
      expect(candidateA.disposeCalls).toBe(1);
      expect(candidateB.disposeCalls).toBe(0);
      expect(fixture.documentSnapshots).not.toContain(candidateA.file.path);
      expectDocumentSnapshotsCoherent(fixture.snapshots);
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps B from publishing when C supersedes it during active A closure", async () => {
    let fixture = createFixture();
    let candidateA = fixture.candidate("A", "a.md", { blockActiveRelease: true });
    let candidateB = fixture.candidate("B", "b.md");
    let candidateC = fixture.candidate("C", "c.md", { blockPrepare: true });

    try {
      await activate(fixture.controller, candidateA);

      let leaseB = fixture.controller.begin(candidateB.file.path);
      let transitionB = settle(
        fixture.controller.transition({ lease: leaseB, prepare: candidateB.prepare }),
      );
      await candidateA.activeReleaseStarted.promise;
      expect(fixture.controller.current()).toBeNull();

      let leaseC = fixture.controller.begin(candidateC.file.path);
      let transitionC = settle(
        fixture.controller.transition({ lease: leaseC, prepare: candidateC.prepare }),
      );
      await candidateC.prepareStarted.promise;

      candidateA.releaseActiveRelease.open();
      expect(valueOf(await transitionB)).toEqual({ status: "superseded" });

      expect(fixture.controller.current()).toBeNull();
      expect(candidateB.activateCalls).toBe(0);
      expect(candidateB.disposeCalls).toBe(1);
      expect(fixture.store.getState()).toMatchObject({
        collabDocument: null,
        openingDocument: { intentId: leaseC.id, path: candidateC.file.path },
        selectedFile: null,
      });
      expect(fixture.documentSnapshots).not.toContain(candidateB.file.path);

      candidateC.releasePrepare.open();
      expect(valueOf(await transitionC)).toMatchObject({
        session: candidateC.session,
        status: "activated",
      });

      expect(fixture.controller.current()).toBe(candidateC.session);
      expect(fixture.store.getState()).toMatchObject({
        collabDocument: candidateC.document,
        openingDocument: null,
        selectedFile: candidateC.file,
      });
      expect(candidateA.events.indexOf("active-release:A:end")).toBeLessThan(
        candidateC.events.indexOf("activate:C"),
      );
      expect(candidateB.events.indexOf("dispose:B:end")).toBeLessThan(
        candidateC.events.indexOf("activate:C"),
      );
      expectDocumentSnapshotsCoherent(fixture.snapshots);
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps a supplied standalone opening visible while its active workspace closes", async () => {
    let fixture = createFixture();
    let candidateA = fixture.candidate("A", "a.md", { blockActiveRelease: true });

    try {
      await activate(fixture.controller, candidateA);
      let standaloneLease = fixture.controller.begin("Draft.md", {
        activeValue: "# A edited\n",
      });
      let closing = settle(fixture.controller.close(standaloneLease));
      await candidateA.activeReleaseStarted.promise;

      expect(fixture.controller.current()).toBeNull();
      expect(fixture.store.getState()).toMatchObject({
        collabDocument: null,
        editorDocument: { path: "", value: "" },
        openingDocument: { intentId: standaloneLease.id, path: "Draft.md" },
        selectedFile: null,
      });

      candidateA.releaseActiveRelease.open();
      expect(valueOf(await closing)).toEqual({ hadActiveSession: true, status: "closed" });
      expect(fixture.store.getState().openingDocument).toEqual({
        intentId: standaloneLease.id,
        path: "Draft.md",
      });

      fixture.controller.finish(standaloneLease);
      expect(fixture.store.getState().openingDocument).toBeNull();
      expect(candidateA.disposeCalls).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });

  it("waits for a superseded uncancelable candidate and disposes it exactly once", async () => {
    let fixture = createFixture();
    let candidateA = fixture.candidate("A", "a.md", {
      blockDispose: true,
      blockPrepare: true,
    });
    let candidateB = fixture.candidate("B", "b.md");

    try {
      let leaseA = fixture.controller.begin(candidateA.file.path);
      let transitionA = settle(
        fixture.controller.transition({ lease: leaseA, prepare: candidateA.prepare }),
      );
      await candidateA.prepareStarted.promise;

      let leaseB = fixture.controller.begin(candidateB.file.path);
      expect(
        valueOf(
          await settle(
            fixture.controller.transition({ lease: leaseB, prepare: candidateB.prepare }),
          ),
        ),
      ).toMatchObject({ status: "activated" });

      candidateA.releasePrepare.open();
      await candidateA.disposeStarted.promise;
      expect(candidateA.disposeCalls).toBe(1);

      let disposed = false;
      let disposal = fixture.startDisposal().then(() => {
        disposed = true;
      });
      await waitUntil(() => fixture.kernel.closed);

      expect(disposed).toBe(false);
      expect(candidateA.disposeCalls).toBe(1);

      candidateA.releaseDispose.open();
      await Promise.all([transitionA, disposal]);

      expect(candidateA.activateCalls).toBe(0);
      expect(candidateA.disposeCalls).toBe(1);
      expect(candidateA.maximumConcurrentDisposals).toBe(1);
      expect(candidateB.disposeCalls).toBe(1);
      expect(fixture.controller.current()).toBeNull();
      expect(fixture.store.getState()).toMatchObject({
        collabDocument: null,
        openingDocument: null,
        selectedFile: null,
      });
      expect(fixture.documentSnapshots).not.toContain(candidateA.file.path);
      expectDocumentSnapshotsCoherent(fixture.snapshots);
    } finally {
      await fixture.dispose();
    }
  });

  it("never activates queued candidates when disposal interrupts a gated active close", async () => {
    let fixture = createFixture();
    let candidateA = fixture.candidate("A", "a.md", { blockActiveRelease: true });
    let candidateB = fixture.candidate("B", "b.md");
    let candidateC = fixture.candidate("C", "c.md");

    try {
      await activate(fixture.controller, candidateA);

      let leaseB = fixture.controller.begin(candidateB.file.path);
      let transitionB = settle(
        fixture.controller.transition({ lease: leaseB, prepare: candidateB.prepare }),
      );
      await candidateA.activeReleaseStarted.promise;

      let leaseC = fixture.controller.begin(candidateC.file.path);
      let transitionC = settle(
        fixture.controller.transition({ lease: leaseC, prepare: candidateC.prepare }),
      );
      await candidateC.prepareFinished.promise;

      let disposed = false;
      let disposal = fixture.startDisposal().then(() => {
        disposed = true;
      });
      await waitUntil(() => fixture.kernel.closed);

      expect(disposed).toBe(false);
      expect(candidateB.activateCalls).toBe(0);
      expect(candidateC.activateCalls).toBe(0);

      candidateA.releaseActiveRelease.open();
      await Promise.all([transitionB, transitionC, disposal]);

      expect(candidateA.disposeCalls).toBe(1);
      expect(candidateB.disposeCalls).toBe(1);
      expect(candidateC.disposeCalls).toBe(1);
      expect(candidateB.activateCalls).toBe(0);
      expect(candidateC.activateCalls).toBe(0);
      expect(fixture.controller.current()).toBeNull();
      expect(fixture.store.getState()).toMatchObject({
        collabDocument: null,
        openingDocument: null,
        selectedFile: null,
      });
      expect(fixture.documentSnapshots).not.toContain(candidateB.file.path);
      expect(fixture.documentSnapshots).not.toContain(candidateC.file.path);
      expectDocumentSnapshotsCoherent(fixture.snapshots);
    } finally {
      await fixture.dispose();
    }
  });
});

type TestGate = {
  open(): void;
  promise: Promise<void>;
};

type CandidateOptions = {
  blockActiveRelease?: boolean;
  blockDispose?: boolean;
  blockPrepare?: boolean;
};

type CandidateProbe = {
  readonly activeReleaseStarted: TestGate;
  activateCalls: number;
  readonly document: CollabDocumentState;
  disposeCalls: number;
  readonly disposeStarted: TestGate;
  readonly events: string[];
  readonly file: MarkdownFileNode;
  maximumConcurrentDisposals: number;
  readonly prepare: () => Promise<PreparedWorkspaceDocumentSession>;
  readonly prepareFinished: TestGate;
  readonly prepareStarted: TestGate;
  readonly releaseActiveRelease: TestGate;
  readonly releaseDispose: TestGate;
  readonly releasePrepare: TestGate;
  readonly session: ReturnType<typeof createActiveWorkspaceDocumentSession>;
};

type Settled<Value> =
  | { reason: unknown; status: "rejected" }
  | { status: "fulfilled"; value: Value };

function createFixture() {
  let store = createWorkspaceAppStore();
  let kernel = createWorkspaceDocumentSessionKernel(store);
  let runtime = ManagedRuntime.make(WorkspaceDocumentSessionCoordinator.layer(kernel));
  let runPromise = <Value, Error>(
    effect: Effect.Effect<Value, Error, WorkspaceDocumentSessionCoordinator>,
  ) => runtime.runPromise(effect);
  let controller = createWorkspaceDocumentSessionController(kernel, runPromise);
  let workspaceRuntime = createMemoryWorkspaceRuntime([], {
    id: "memory:document-session-coordinator",
  });
  let gates = new Set<TestGate>();
  let events: string[] = [];
  let snapshots: WorkspaceAppState[] = [];
  let documentSnapshots: Array<string | null> = [];
  let unsubscribe = store.subscribe((snapshot) => {
    snapshots.push(snapshot);
    documentSnapshots.push(snapshot.collabDocument?.path ?? null);
  });
  let disposal: Promise<void> | null = null;

  function gate(open = false) {
    let resolve!: () => void;
    let opened = false;
    let promise = new Promise<void>((nextResolve) => {
      resolve = nextResolve;
    });
    let nextGate: TestGate = {
      open() {
        if (opened) return;
        opened = true;
        resolve();
      },
      promise,
    };
    gates.add(nextGate);
    if (open) nextGate.open();
    return nextGate;
  }

  function candidate(id: string, path: string, options: CandidateOptions = {}): CandidateProbe {
    let file = { kind: "file" as const, name: path.split("/").at(-1) ?? path, path };
    let document = {
      docId: `document:${id}`,
      path,
      value: `# ${id}\n`,
    } as CollabDocumentState;
    let session = createActiveWorkspaceDocumentSession(
      workspaceRuntime,
      file,
      document,
      Number(id.codePointAt(0) ?? 0),
    );
    let prepareStarted = gate();
    let prepareFinished = gate();
    let releasePrepare = gate(!options.blockPrepare);
    let disposeStarted = gate();
    let releaseDispose = gate(!options.blockDispose);
    let activeReleaseStarted = gate();
    let releaseActiveRelease = gate(!options.blockActiveRelease);
    let concurrentDisposals = 0;
    let probe: CandidateProbe;

    let prepared: PreparedWorkspaceDocumentSession = {
      activate() {
        probe.activateCalls += 1;
        events.push(`activate:${id}`);
        return {
          async release() {
            events.push(`active-release:${id}:start`);
            activeReleaseStarted.open();
            await releaseActiveRelease.promise;
            events.push(`active-release:${id}:end`);
          },
          retire() {
            events.push(`retire:${id}`);
          },
          session,
        };
      },
      async dispose() {
        probe.disposeCalls += 1;
        concurrentDisposals += 1;
        probe.maximumConcurrentDisposals = Math.max(
          probe.maximumConcurrentDisposals,
          concurrentDisposals,
        );
        events.push(`dispose:${id}:start`);
        disposeStarted.open();
        await releaseDispose.promise;
        events.push(`dispose:${id}:end`);
        concurrentDisposals -= 1;
      },
      document,
      file,
      saveState: "saved",
      value: document.value,
    };

    probe = {
      activeReleaseStarted,
      activateCalls: 0,
      document,
      disposeCalls: 0,
      disposeStarted,
      events,
      file,
      maximumConcurrentDisposals: 0,
      async prepare() {
        events.push(`prepare:${id}:start`);
        prepareStarted.open();
        await releasePrepare.promise;
        events.push(`prepare:${id}:end`);
        prepareFinished.open();
        return prepared;
      },
      prepareFinished,
      prepareStarted,
      releaseActiveRelease,
      releaseDispose,
      releasePrepare,
      session,
    };
    return probe;
  }

  function startDisposal() {
    return (disposal ??= runtime.dispose());
  }

  return {
    candidate,
    controller,
    documentSnapshots,
    async dispose() {
      for (let nextGate of gates) nextGate.open();
      await startDisposal();
      unsubscribe();
      await workspaceRuntime.dispose();
    },
    events,
    kernel,
    snapshots,
    startDisposal,
    store,
  };
}

async function activate(controller: WorkspaceDocumentSessionController, candidate: CandidateProbe) {
  let lease = controller.begin(candidate.file.path);
  let outcome = await controller.transition({ lease, prepare: candidate.prepare });
  expect(outcome).toMatchObject({ session: candidate.session, status: "activated" });
}

function expectDocumentSnapshotsCoherent(snapshots: WorkspaceAppState[]) {
  for (let snapshot of snapshots) {
    if (!snapshot.collabDocument) continue;
    expect(snapshot.selectedFile?.path).toBe(snapshot.collabDocument.path);
    expect(snapshot.editorDocument.path).toBe(snapshot.collabDocument.path);
  }
}

function settle<Value>(promise: Promise<Value>): Promise<Settled<Value>> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ reason, status: "rejected" as const }),
  );
}

function valueOf<Value>(settled: Settled<Value>) {
  if (settled.status == "rejected") throw settled.reason;
  return settled.value;
}

async function waitUntil(predicate: () => boolean) {
  while (!predicate()) await Promise.resolve();
}
