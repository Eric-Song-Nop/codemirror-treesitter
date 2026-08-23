export type DocumentPersistenceFence = {
  epoch: number;
  sessionId: string;
};

export type DocumentPersistenceOutcome<T> =
  | { status: "blocked"; reason: "closed" | "refresh" }
  | { status: "busy" }
  | { status: "completed"; value: T }
  | { status: "rejected-generation" }
  | { status: "stale" }
  | { durableGeneration: number; status: "superseded" };

export type DocumentPersistenceCloseOutcome = { status: "closed" } | { status: "stale" };

type ProjectionResolution = {
  reject: (error: unknown) => void;
  resolve: (outcome: DocumentPersistenceOutcome<unknown>) => void;
};

type ProjectionRequest = ProjectionResolution & {
  fence: DocumentPersistenceFence;
  generation: number;
  run: () => Promise<unknown>;
  superseded: ProjectionResolution[];
};

type BarrierResolution = {
  reject: (error: unknown) => void;
  resolve: () => void;
};

type BarrierRequest = {
  run: () => Promise<void>;
  waiters: BarrierResolution[];
};

type PathLane = {
  acceptedGeneration: number;
  closed: boolean;
  fence: DocumentPersistenceFence | null;
  inflight: Promise<void> | null;
  pending: ProjectionRequest | null;
  queuedBarrier: BarrierRequest | null;
};

export class DocumentPersistenceCoordinator {
  private readonly lanes = new Map<string, PathLane>();

  schedule<T>(input: {
    epoch: number;
    generation: number;
    path: string;
    run: () => Promise<T>;
    sessionId: string;
    workspaceId: string;
  }): Promise<DocumentPersistenceOutcome<T>> {
    assertGeneration(input.generation);
    assertEpoch(input.epoch);
    let key = laneKey(input.workspaceId, input.path);
    let lane = this.lanes.get(key) ?? createLane();
    this.lanes.set(key, lane);
    let fence = { epoch: input.epoch, sessionId: input.sessionId };

    if (lane.closed || (lane.fence && !sameFence(lane.fence, fence))) {
      return Promise.resolve({ status: "busy" });
    }
    lane.fence ??= fence;
    if (input.generation <= lane.acceptedGeneration) {
      return Promise.resolve({ status: "rejected-generation" });
    }
    lane.acceptedGeneration = input.generation;

    return new Promise<DocumentPersistenceOutcome<T>>((resolve, reject) => {
      let superseded: ProjectionResolution[] = [];
      if (lane.pending) {
        superseded = [
          ...lane.pending.superseded,
          { reject: lane.pending.reject, resolve: lane.pending.resolve },
        ];
      }
      lane.pending = {
        fence,
        generation: input.generation,
        reject,
        resolve: resolve as (outcome: DocumentPersistenceOutcome<unknown>) => void,
        run: input.run,
        superseded,
      };
      this.drain(key, lane);
    });
  }

  barrier(input: { path: string; run: () => Promise<void>; workspaceId: string }) {
    let key = laneKey(input.workspaceId, input.path);
    let lane = this.lanes.get(key) ?? createLane();
    this.lanes.set(key, lane);
    this.blockPending(lane, "refresh");

    return new Promise<void>((resolve, reject) => {
      let waiter = { reject, resolve };
      if (lane.queuedBarrier) {
        lane.queuedBarrier.waiters.push(waiter);
      } else {
        lane.queuedBarrier = { run: input.run, waiters: [waiter] };
      }
      this.drain(key, lane);
    });
  }

  async flush(input: { path: string; workspaceId: string }) {
    let lane = this.lanes.get(laneKey(input.workspaceId, input.path));
    while (lane?.inflight || lane?.pending || lane?.queuedBarrier) {
      if (lane.inflight) await lane.inflight;
      else this.drain(laneKey(input.workspaceId, input.path), lane);
      lane = this.lanes.get(laneKey(input.workspaceId, input.path));
    }
  }

  async close(input: {
    epoch?: number;
    path: string;
    sessionId?: string;
    workspaceId: string;
  }): Promise<DocumentPersistenceCloseOutcome> {
    let key = laneKey(input.workspaceId, input.path);
    let lane = this.lanes.get(key);
    if (!lane) return { status: "closed" };
    if (
      input.epoch != null &&
      input.sessionId != null &&
      lane.fence &&
      !sameFence(lane.fence, { epoch: input.epoch, sessionId: input.sessionId })
    ) {
      return { status: "stale" };
    }

    lane.closed = true;
    this.blockPending(lane, "closed");
    let queuedBarrier = lane.queuedBarrier;
    lane.queuedBarrier = null;
    for (let waiter of queuedBarrier?.waiters ?? []) waiter.resolve();
    await lane.inflight;
    if (this.lanes.get(key) === lane) this.lanes.delete(key);
    return { status: "closed" };
  }

  busy(input: { path: string; workspaceId: string }) {
    let lane = this.lanes.get(laneKey(input.workspaceId, input.path));
    return Boolean(lane?.fence || lane?.inflight || lane?.pending || lane?.queuedBarrier);
  }

  private blockPending(lane: PathLane, reason: "closed" | "refresh") {
    let pending = lane.pending;
    lane.pending = null;
    if (!pending) return;
    pending.resolve({ reason, status: "blocked" });
    for (let waiter of pending.superseded) waiter.resolve({ reason, status: "blocked" });
  }

  private drain(key: string, lane: PathLane) {
    if (lane.inflight || lane.closed) return;
    let work = this.takeWork(lane);
    if (!work) {
      if (!lane.fence) this.lanes.delete(key);
      return;
    }
    lane.inflight = work().finally(() => {
      lane.inflight = null;
      this.drain(key, lane);
    });
  }

  private takeWork(lane: PathLane): (() => Promise<void>) | null {
    let barrier = lane.queuedBarrier;
    if (barrier) {
      lane.queuedBarrier = null;
      return async () => {
        try {
          await barrier.run();
          for (let waiter of barrier.waiters) waiter.resolve();
        } catch (error) {
          for (let waiter of barrier.waiters) waiter.reject(error);
        }
      };
    }

    let request = lane.pending;
    lane.pending = null;
    if (!request) return null;
    return async () => {
      try {
        let value = await request.run();
        if (!sameFence(lane.fence, request.fence) || lane.closed) {
          request.resolve({ status: "stale" });
          for (let waiter of request.superseded) waiter.resolve({ status: "stale" });
          return;
        }
        request.resolve({ status: "completed", value });
        for (let waiter of request.superseded) {
          waiter.resolve({ durableGeneration: request.generation, status: "superseded" });
        }
      } catch (error) {
        request.reject(error);
        for (let waiter of request.superseded) waiter.reject(error);
      }
    };
  }
}

export const workspaceDocumentPersistenceCoordinator = new DocumentPersistenceCoordinator();

function createLane(): PathLane {
  return {
    acceptedGeneration: -1,
    closed: false,
    fence: null,
    inflight: null,
    pending: null,
    queuedBarrier: null,
  };
}

function laneKey(workspaceId: string, rawPath: string) {
  let path = rawPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  let parts = path.split("/").filter(Boolean);
  if (!workspaceId || !parts.length || parts.some((part) => part == "." || part == "..")) {
    throw new Error("Document persistence requires a workspace and normalized file path.");
  }
  return `${encodeURIComponent(workspaceId)}:${parts.map(encodeURIComponent).join("/")}`;
}

function sameFence(left: DocumentPersistenceFence | null, right: DocumentPersistenceFence) {
  return left?.sessionId == right.sessionId && left.epoch == right.epoch;
}

function assertGeneration(generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError("Document generation must be a non-negative safe integer.");
  }
}

function assertEpoch(epoch: number) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new RangeError("Document epoch must be a non-negative safe integer.");
  }
}
