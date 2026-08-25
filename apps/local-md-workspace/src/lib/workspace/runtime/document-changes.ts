import type { AccessDirectoryHandle } from "../file-system.ts";
import type { SourceObservation, SourceProbe } from "../storage/types.ts";
import type {
  WorkspaceDocumentChangeHint,
  WorkspaceDocumentChangeSource,
  WorkspaceDocumentChangeSubscription,
  WorkspaceTextSnapshot,
} from "./types.ts";

type FileSystemChangeRecordLike = {
  relativePathComponents?: string[];
  relativePathMovedFrom?: string[];
  type?: string;
};

type FileSystemObserverLike = {
  disconnect(): void;
  observe(handle: AccessDirectoryHandle, options?: { recursive?: boolean }): Promise<void>;
};

type FileSystemObserverConstructor = new (
  callback: (records: FileSystemChangeRecordLike[]) => void,
) => FileSystemObserverLike;

export type WorkspaceDocumentChangeMonitorOptions = {
  hintDebounceMs?: number;
  intervalMs?: number;
  localRoot?: AccessDirectoryHandle;
  maxIntervalMs?: number;
  observe: (path: string) => Promise<SourceObservation<WorkspaceTextSnapshot>>;
  observerConstructor?: FileSystemObserverConstructor;
  probe?: (path: string) => Promise<SourceObservation<SourceProbe>>;
  random?: () => number;
};

type Sample = {
  failed: boolean;
  key: string;
};

export class WorkspaceDocumentChangeMonitor implements WorkspaceDocumentChangeSource {
  private readonly hintDebounceMs: number;
  private readonly intervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly observerConstructor: FileSystemObserverConstructor | undefined;
  private readonly subscriptions = new Set<WorkspaceDocumentChangeSubscription>();

  constructor(private readonly options: WorkspaceDocumentChangeMonitorOptions) {
    this.intervalMs = positiveFinite(options.intervalMs ?? 3_000, "polling interval");
    this.maxIntervalMs = positiveFinite(options.maxIntervalMs ?? 60_000, "maximum interval");
    this.hintDebounceMs = nonNegativeFinite(options.hintDebounceMs ?? 120, "hint debounce");
    if (this.maxIntervalMs < this.intervalMs) {
      throw new RangeError(
        "Workspace document maximum interval cannot be shorter than its interval.",
      );
    }
    this.observerConstructor =
      options.observerConstructor ??
      (
        globalThis as typeof globalThis & {
          FileSystemObserver?: FileSystemObserverConstructor;
        }
      ).FileSystemObserver;
  }

  subscribe(
    path: string,
    listener: (hint: WorkspaceDocumentChangeHint) => void,
  ): WorkspaceDocumentChangeSubscription {
    let subscription = new WorkspaceDocumentSubscription({
      hintDebounceMs: this.hintDebounceMs,
      intervalMs: this.intervalMs,
      listener,
      localRoot: this.options.localRoot,
      maxIntervalMs: this.maxIntervalMs,
      observe: this.options.observe,
      observerConstructor: this.observerConstructor,
      path: normalizeDocumentPath(path),
      probe: this.options.probe,
      random: this.options.random ?? Math.random,
    });
    let exposedSubscription: WorkspaceDocumentChangeSubscription = {
      dispose: () => {
        subscription.dispose();
        this.subscriptions.delete(exposedSubscription);
      },
    };
    this.subscriptions.add(exposedSubscription);
    void subscription.start();
    return exposedSubscription;
  }

  dispose() {
    for (let subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.clear();
  }
}

class WorkspaceDocumentSubscription implements WorkspaceDocumentChangeSubscription {
  private baseline: string | null = null;
  private disposed = false;
  private failureCount = 0;
  private hintKind: "changed" | "resync-required" | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeObserver: FileSystemObserverLike | null = null;
  private pollInFlight = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly input: {
      hintDebounceMs: number;
      intervalMs: number;
      listener: (hint: WorkspaceDocumentChangeHint) => void;
      localRoot?: AccessDirectoryHandle;
      maxIntervalMs: number;
      observe: (path: string) => Promise<SourceObservation<WorkspaceTextSnapshot>>;
      observerConstructor?: FileSystemObserverConstructor;
      path: string;
      probe?: (path: string) => Promise<SourceObservation<SourceProbe>>;
      random: () => number;
    },
  ) {
    globalThis.addEventListener?.("online", this.handleResume);
    globalThis.addEventListener?.("pageshow", this.handleResume);
    globalThis.document?.addEventListener("visibilitychange", this.handleVisibility);
  }

  async start() {
    try {
      this.baseline = (await this.sample()).key;
    } catch {
      if (!this.disposed) this.queueHint("resync-required");
    }
    if (this.disposed) return;
    if (await this.startNativeObserver()) return;
    this.fallbackToPolling();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.nativeObserver?.disconnect();
    this.nativeObserver = null;
    this.clearPollTimer();
    if (this.hintTimer != null) clearTimeout(this.hintTimer);
    this.hintTimer = null;
    this.hintKind = null;
    globalThis.removeEventListener?.("online", this.handleResume);
    globalThis.removeEventListener?.("pageshow", this.handleResume);
    globalThis.document?.removeEventListener("visibilitychange", this.handleVisibility);
  }

  private async startNativeObserver() {
    if (!this.input.localRoot || !this.input.observerConstructor) return false;
    let observer: FileSystemObserverLike | null = null;
    try {
      let { directory, fileName } = await resolveParentDirectory(
        this.input.localRoot,
        this.input.path,
      );
      if (this.disposed) return true;
      observer = new this.input.observerConstructor((records) => {
        if (this.disposed) return;
        if (records.some((record) => record.type == "errored")) {
          this.fallbackToPolling();
          return;
        }
        let relevant = records.filter((record) => recordTargetsFile(record, fileName));
        if (!relevant.length) return;
        this.queueHint(
          relevant.some((record) => record.type == "unknown") ? "resync-required" : "changed",
        );
      });
      await observer.observe(directory, { recursive: false });
      if (this.disposed) observer.disconnect();
      else this.nativeObserver = observer;
      return true;
    } catch {
      observer?.disconnect();
      return false;
    }
  }

  private fallbackToPolling() {
    if (this.disposed) return;
    let hadNativeObserver = Boolean(this.nativeObserver);
    this.nativeObserver?.disconnect();
    this.nativeObserver = null;
    if (hadNativeObserver || this.pollTimer == null) {
      this.emit({ kind: "monitor-unavailable", path: this.input.path });
    }
    this.schedulePoll(0, true);
  }

  private schedulePoll(delay = this.nextPollDelay(), replace = false) {
    if (this.disposed || this.nativeObserver || this.pollInFlight || globalThis.document?.hidden) {
      return;
    }
    if (this.pollTimer != null) {
      if (!replace) return;
      this.clearPollTimer();
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }

  private clearPollTimer() {
    if (this.pollTimer != null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private nextPollDelay() {
    let exponent = Math.min(this.failureCount, 8);
    let backoff = Math.min(this.input.maxIntervalMs, this.input.intervalMs * 2 ** exponent);
    let random = Math.max(0, Math.min(1, this.input.random()));
    return Math.round(backoff * (0.8 + random * 0.4));
  }

  private async poll() {
    if (this.pollInFlight || this.disposed || this.nativeObserver) return;
    this.pollInFlight = true;
    try {
      let next = await this.sample();
      if (this.disposed) return;
      if (this.baseline != null && next.key != this.baseline) this.queueHint("changed");
      this.baseline = next.key;
      this.failureCount = next.failed ? this.failureCount + 1 : 0;
    } catch {
      if (this.disposed) return;
      this.failureCount += 1;
      this.queueHint("resync-required");
    } finally {
      this.pollInFlight = false;
      this.schedulePoll();
    }
  }

  private async sample(): Promise<Sample> {
    if (this.input.probe) {
      let probe = await this.input.probe(this.input.path);
      if (probe.state == "missing") return { failed: false, key: "missing" };
      if (probe.state == "unavailable") {
        return { failed: true, key: `unavailable:${probe.error.code}` };
      }
      let revision = probe.value.revision;
      if (revision?.validation == "atomic") {
        return {
          failed: false,
          key: `atomic:${revision.kind}:${revision.value}`,
        };
      }
    }

    let observation = await this.input.observe(this.input.path);
    if (observation.state == "missing") return { failed: false, key: "missing" };
    if (observation.state == "unavailable") {
      return { failed: true, key: `unavailable:${observation.error.code}` };
    }
    return {
      failed: false,
      key: `snapshot:${observation.value.contentHash}:${observation.value.revision.validation}:${observation.value.revision.kind}:${observation.value.revision.value}`,
    };
  }

  private readonly handleResume = () => {
    if (this.disposed) return;
    this.queueHint("resync-required");
    if (!this.nativeObserver) this.schedulePoll(0, true);
  };

  private readonly handleVisibility = () => {
    if (!globalThis.document?.hidden) this.handleResume();
  };

  private queueHint(kind: "changed" | "resync-required") {
    if (this.disposed) return;
    if (kind == "resync-required" || this.hintKind == null) this.hintKind = kind;
    if (this.hintTimer != null) return;
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      let queued = this.hintKind;
      this.hintKind = null;
      if (queued) this.emit({ kind: queued, path: this.input.path });
    }, this.input.hintDebounceMs);
  }

  private emit(hint: WorkspaceDocumentChangeHint) {
    try {
      this.input.listener(hint);
    } catch {
      // A consumer failure must not stop storage observation.
    }
  }
}

function recordTargetsFile(record: FileSystemChangeRecordLike, fileName: string) {
  if (record.type == "unknown" || record.type == "errored") return true;
  return (
    pathTargetsFile(record.relativePathComponents, fileName) ||
    pathTargetsFile(record.relativePathMovedFrom, fileName)
  );
}

function pathTargetsFile(components: string[] | undefined, fileName: string) {
  return Boolean(components?.length && components[0] == fileName);
}

async function resolveParentDirectory(root: AccessDirectoryHandle, path: string) {
  let parts = path.split("/");
  let fileName = parts.pop()!;
  let directory = root;
  for (let part of parts) directory = await directory.getDirectoryHandle(part);
  return { directory, fileName };
}

function normalizeDocumentPath(path: string) {
  let parts = path.trim().replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part == "." || part == "..")) {
    throw new Error("Workspace document observer requires a normalized file path.");
  }
  return parts.join("/");
}

function positiveFinite(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Workspace document ${label} must be positive.`);
  }
  return value;
}

function nonNegativeFinite(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Workspace document ${label} must not be negative.`);
  }
  return value;
}
