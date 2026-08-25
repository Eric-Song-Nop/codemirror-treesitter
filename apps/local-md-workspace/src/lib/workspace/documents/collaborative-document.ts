import {
  acknowledgeCollabDocumentSourceSaved,
  captureCollabDocumentMaterialization,
  collabDocumentNeedsSourceWrite,
  commitCollabDocumentExternalEdit,
  flushCollabDocumentPersistence,
  getCollabDocumentValue,
  materializeCollabDocument,
  resolveCollabRecoveryUseExternal,
  saveCollabDocumentSnapshot,
  scheduleCollabDocumentSnapshotFlush,
  type CollabDocumentState,
  type CollabDocumentSource,
} from "@/lib/collaboration/markdown-document";
import { createCollabDocumentBroadcastSync } from "@/lib/collaboration/document-sync";
import { createDebouncedTask, type DebouncedTask } from "@/lib/scheduling/debounced-task";
import type {
  CurrentDocumentChangeSource,
  CurrentDocumentChangeSubscription,
  WorkspaceDocumentPort,
  WorkspaceIdentity,
  WorkspaceTextSnapshot,
} from "@/lib/workspace/runtime/types";
import type { SourceRevision } from "@/lib/workspace/storage/types";
import type {
  CollaborativeDocumentSnapshot,
  DocumentListener,
  DocumentListenerEvent,
  EditResult,
  ExactTextEdit,
  UseExternalChangeResult,
  WorkspaceCollaborativeDocument,
} from "./contracts.ts";

const materializeDelayMs = 500;
const materializeMaxWaitMs = 2_000;

export type ManagedCollaborativeDocumentOptions = {
  changes: CurrentDocumentChangeSource | null;
  identity: WorkspaceIdentity;
  path: string;
  source: WorkspaceDocumentPort;
  state: CollabDocumentState;
};

type FlushWaiter = {
  generation: number;
  reject: (error: unknown) => void;
  resolve: () => void;
};

export class ManagedCollaborativeDocument implements WorkspaceCollaborativeDocument {
  private acceptingEdits = true;
  private closeRequest: Promise<void> | null = null;
  private completedGeneration = 0;
  private generation = 0;
  private lastFailure: { error: unknown; generation: number } | null = null;
  private readonly listeners = new Set<DocumentListener>();
  private readonly materializer: DebouncedTask;
  private persistenceStatus: CollaborativeDocumentSnapshot["persistenceStatus"];
  private requestedGeneration = 0;
  private sourceOperations: Promise<void> = Promise.resolve();
  private readonly stopBroadcast: () => void;
  private readonly stopDocumentChanges: CurrentDocumentChangeSubscription | null;
  private readonly stopLoroSubscription: () => void;
  private value: string;
  private readonly waiters = new Set<FlushWaiter>();

  constructor(private readonly options: ManagedCollaborativeDocumentOptions) {
    this.value = getCollabDocumentValue(options.state);
    this.persistenceStatus = collabDocumentNeedsSourceWrite(options.state) ? "pending" : "saved";
    this.materializer = createDebouncedTask({
      delayMs: materializeDelayMs,
      maxWaitMs: materializeMaxWaitMs,
      run: () => this.materializeRequestedGeneration(),
    });
    this.stopLoroSubscription = options.state.doc.subscribe(() => {
      this.captureLoroChange();
    }) as () => void;
    this.stopBroadcast = createCollabDocumentBroadcastSync({
      doc: options.state.doc,
      docId: options.state.docId,
      identity: options.identity,
    });
    this.stopDocumentChanges =
      options.changes?.subscribe(options.path, (hint) => {
        if (hint.kind != "monitor-unavailable") this.requestMaterialization();
      }) ?? null;

    if (collabDocumentNeedsSourceWrite(options.state)) this.requestMaterialization();
  }

  get collabState() {
    return this.options.state;
  }

  get docId() {
    return this.options.state.docId;
  }

  get liveMdConfig() {
    return this.options.state.liveMdConfig;
  }

  get loroDoc() {
    return this.options.state.doc;
  }

  get path() {
    return this.options.path;
  }

  read() {
    this.assertOpen();
    return this.value;
  }

  snapshot(): CollaborativeDocumentSnapshot {
    return {
      generation: this.generation,
      path: this.path,
      persistenceError: this.lastFailure?.error,
      persistenceStatus: this.persistenceStatus,
      sourceKind: this.options.state.source.kind,
      value: this.value,
    };
  }

  edit(edits: readonly ExactTextEdit[]): EditResult {
    this.assertEditable();
    let conflict = validateEdits(edits, this.value);
    if (conflict) return conflict;
    if (!edits.length) {
      return { appliedEdits: 0, generation: this.generation, status: "applied", value: this.value };
    }

    let text = this.options.state.doc.getText("markdown");
    try {
      for (let edit of edits.toSorted(compareEdits).toReversed()) {
        if (edit.to > edit.from) text.delete(edit.from, edit.to - edit.from);
        if (edit.insert) text.insert(edit.from, edit.insert);
      }
      commitCollabDocumentExternalEdit(this.options.state);
    } finally {
      text.free();
    }
    this.captureLoroChange();
    return {
      appliedEdits: edits.length,
      generation: this.generation,
      status: "applied",
      value: this.value,
    };
  }

  applyRemoteUpdate(update: Uint8Array) {
    this.assertEditable();
    if (update.byteLength) this.options.state.doc.import(update);
    this.captureLoroChange();
  }

  subscribe(listener: DocumentListener) {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  flush() {
    this.assertOpen();
    let target = this.requestedGeneration;
    if (target <= this.completedGeneration) {
      let failure = this.lastFailure;
      return failure && failure.generation >= target
        ? Promise.reject(failure.error)
        : flushCollabDocumentPersistence(this.options.state);
    }

    let barrier = new Promise<void>((resolve, reject) => {
      this.waiters.add({ generation: target, reject, resolve });
    });
    void this.materializer.flush();
    return barrier;
  }

  async importExternalChange() {
    this.assertOpen();
    this.requestMaterialization();
    await this.flush();
  }

  async writeCopy(rawPath: string) {
    this.assertOpen();
    let path = normalizeWorkspaceDocumentPath(rawPath);
    if (path == this.path) throw new Error("A document copy requires a different path.");
    await this.runSourceOperation(async () => {
      await commitExplicitTarget(this.options.source, path, this.value);
    });
  }

  async useExternalChange(expectedRevision: SourceRevision): Promise<UseExternalChangeResult> {
    this.assertOpen();
    let result = await this.runSourceOperation(async () => {
      let state = this.options.state;
      if (state.source.kind != "recovery-required") {
        throw new Error("The document does not require external-source recovery.");
      }
      let observation = await this.options.source.observe(this.path);
      if (observation.state == "missing") throw new Error(`${this.path} no longer exists.`);
      if (observation.state == "unavailable") throw observation.error;
      let resolution = await resolveCollabRecoveryUseExternal(
        state,
        observation.value,
        expectedRevision,
      );
      if (resolution.status == "incoming-changed") {
        return { status: "incoming-changed" as const };
      }
      await saveCollabDocumentSnapshot(this.backend(), state);
      return { status: "applied" as const, update: resolution.update };
    });
    this.captureLoroChange();
    this.requestMaterialization();
    return result;
  }

  async recreateSource() {
    this.assertOpen();
    await this.runSourceOperation(async () => {
      let state = this.options.state;
      if (state.source.kind != "missing") {
        throw new Error("The document source is not missing.");
      }
      let materialization = captureCollabDocumentMaterialization(state);
      let snapshot = await commitExplicitTarget(
        this.options.source,
        this.path,
        materialization.value,
      );
      await acknowledgeCollabDocumentSourceSaved(this.backend(), state, materialization.value, {
        frontiers: materialization.frontiers,
        source: sourceBaseline(snapshot),
        versionVector: materialization.versionVector,
      });
    });
    this.requestMaterialization();
  }

  close() {
    return (this.closeRequest ??= this.closeDocument());
  }

  private async closeDocument() {
    this.acceptingEdits = false;
    let error: unknown;
    try {
      await this.flush();
    } catch (cause) {
      error = cause;
    }

    this.materializer.dispose();
    this.stopDocumentChanges?.dispose();
    this.stopBroadcast();
    this.stopLoroSubscription();
    this.emit({ kind: "closed", snapshot: this.snapshot() });
    this.listeners.clear();
    try {
      await this.options.state.dispose();
    } catch (cause) {
      error = error ? new AggregateError([error, cause], `Failed to close ${this.path}.`) : cause;
    }
    if (error) throw error;
  }

  private captureLoroChange() {
    if (!this.acceptingEdits) return;
    let value = getCollabDocumentValue(this.options.state);
    if (value == this.value) return;

    this.value = value;
    this.options.state.value = value;
    this.generation += 1;
    scheduleCollabDocumentSnapshotFlush(this.options.state);
    this.requestMaterialization();
    this.emit({ kind: "changed", snapshot: this.snapshot() });
  }

  private requestMaterialization() {
    this.requestedGeneration += 1;
    this.persistenceStatus = "pending";
    this.materializer.schedule();
  }

  private async materializeRequestedGeneration() {
    let target = this.requestedGeneration;
    if (target <= this.completedGeneration) return;
    this.persistenceStatus = "saving";

    let result: Awaited<ReturnType<typeof materializeCollabDocument>> | null = null;
    let error: unknown;
    try {
      result = await this.runSourceOperation(() =>
        materializeCollabDocument(this.backend(), this.options.state),
      );
      this.persistenceStatus = this.requestedGeneration > target ? "pending" : "saved";
      this.lastFailure = null;
    } catch (cause) {
      error = cause;
      this.persistenceStatus = this.options.state.source.kind == "present" ? "error" : "blocked";
      this.lastFailure = { error: cause, generation: target };
      await flushCollabDocumentPersistence(this.options.state).catch(() => {});
    }

    this.completedGeneration = target;
    if (result) {
      this.value = getCollabDocumentValue(this.options.state);
      this.emit({
        externalEdit: result.externalEdit,
        kind: "materialized",
        materialization: result.materialization,
        snapshot: this.snapshot(),
        sourceUpdate: result.sourceUpdate,
      });
    } else {
      this.emit({ error, kind: "persistence-error", snapshot: this.snapshot() });
    }
    this.settleWaiters(target, error);
    if (this.requestedGeneration > target) this.materializer.schedule();
  }

  private runSourceOperation<Value>(operation: () => Promise<Value>) {
    let request = this.sourceOperations.catch(() => {}).then(operation);
    this.sourceOperations = request.then(
      () => {},
      () => {},
    );
    return request;
  }

  private settleWaiters(generation: number, error: unknown) {
    for (let waiter of this.waiters) {
      if (waiter.generation > generation) continue;
      this.waiters.delete(waiter);
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  private emit(event: DocumentListenerEvent) {
    for (let listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscriber failures must not interrupt document persistence.
      }
    }
  }

  private backend(): CollabDocumentSource {
    return { documents: this.options.source, identity: this.options.identity };
  }

  private assertEditable() {
    this.assertOpen();
    if (!this.acceptingEdits)
      throw new Error(`The collaborative document ${this.path} is closing.`);
  }

  private assertOpen() {
    if (this.closeRequest) throw new Error(`The collaborative document ${this.path} is closed.`);
  }
}

function validateEdits(edits: readonly ExactTextEdit[], value: string): EditResult | null {
  let sorted = edits
    .map((edit, editIndex) => ({ edit, editIndex }))
    .toSorted((left, right) => compareEdits(left.edit, right.edit));
  for (let index = 0; index < sorted.length; index++) {
    let { edit, editIndex } = sorted[index]!;
    if (
      !Number.isSafeInteger(edit.from) ||
      !Number.isSafeInteger(edit.to) ||
      edit.from < 0 ||
      edit.to < edit.from ||
      edit.to > value.length
    ) {
      return { editIndex, reason: "invalid-range", status: "conflict", value };
    }
    if (index > 0 && edit.from < sorted[index - 1]!.edit.to) {
      return { editIndex, reason: "overlapping-edits", status: "conflict", value };
    }
    if (value.slice(edit.from, edit.to) != edit.expectedText) {
      return { editIndex, reason: "expected-text-mismatch", status: "conflict", value };
    }
  }
  return null;
}

function compareEdits(left: ExactTextEdit, right: ExactTextEdit) {
  return left.from - right.from || left.to - right.to;
}

async function commitExplicitTarget(source: WorkspaceDocumentPort, path: string, value: string) {
  let result = await source.commit({ condition: { kind: "if-absent" }, path, value });
  if (result.status == "conflict") throw new Error(`${path} already exists.`);
  let observation = await source.observe(path);
  if (observation.state == "unavailable") throw observation.error;
  if (observation.state == "missing" || observation.value.value != value) {
    throw new Error(`The write outcome for ${path} is unknown.`);
  }
  return observation.value;
}

function sourceBaseline(snapshot: WorkspaceTextSnapshot) {
  return { contentHash: snapshot.contentHash, revision: snapshot.revision };
}

export function normalizeWorkspaceDocumentPath(rawPath: string) {
  let parts = rawPath.trim().replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part == "." || part == "..")) {
    throw new Error("Workspace documents require a normalized file path.");
  }
  return parts.join("/");
}
