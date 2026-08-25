import {
  clearWorkspaceDocumentOpening,
  clearWorkspaceDocumentView,
  publishWorkspaceDocumentOpening,
  publishWorkspaceDocumentView,
  type WorkspaceAppStore,
  type WorkspaceDocumentView,
} from "./workspace-store.ts";
import type { WorkspaceDocumentContext } from "@/lib/workspace/document-context";

export type PreparedWorkspaceDocumentView = Readonly<{
  activate: () => InstalledWorkspaceDocumentView;
  view: WorkspaceDocumentView;
}>;

type InstalledWorkspaceDocumentView = Readonly<{
  context: WorkspaceDocumentContext;
  release: () => void;
  retire: () => void;
}>;

type WorkspaceDocumentSelectionInput = Readonly<{
  prepare: (signal: AbortSignal) => Promise<PreparedWorkspaceDocumentView | null>;
  signal: AbortSignal;
}>;

type WorkspaceDocumentCloseResult = { hadActiveView: boolean } | null;

export class WorkspaceDocumentViewCoordinator {
  private active: InstalledWorkspaceDocumentView | null = null;
  private closed = false;
  private pending: AbortController | null = null;

  constructor(private readonly store: WorkspaceAppStore) {}

  begin(path: string, options: { currentValue?: string } = {}) {
    this.assertOpen();
    this.invalidate();
    let request = new AbortController();
    this.pending = request;
    publishWorkspaceDocumentOpening(this.store, { path }, options.currentValue);
    return request.signal;
  }

  async close(signal?: AbortSignal): Promise<WorkspaceDocumentCloseResult> {
    this.assertOpen();
    if (signal && !this.isCurrent(signal)) return null;
    if (!signal) this.invalidate();

    let hadActiveView = Boolean(this.active);
    this.releaseActiveView(Boolean(signal));
    return { hadActiveView };
  }

  current() {
    return this.active?.context ?? null;
  }

  finish(signal: AbortSignal) {
    if (!this.isCurrent(signal)) return;
    clearWorkspaceDocumentOpening(this.store);
  }

  invalidate() {
    this.pending?.abort();
    this.pending = null;
    clearWorkspaceDocumentOpening(this.store);
  }

  isCurrent(signal: AbortSignal) {
    return !signal.aborted && this.pending?.signal === signal;
  }

  async select(input: WorkspaceDocumentSelectionInput) {
    if (!this.isCurrent(input.signal)) return null;
    try {
      let candidate = await input.prepare(input.signal);
      if (!candidate || !this.isCurrent(input.signal)) return null;

      this.releaseActiveView(true);
      if (!this.isCurrent(input.signal)) return null;

      let installed = candidate.activate();
      this.active = installed;
      try {
        publishWorkspaceDocumentView(this.store, candidate.view);
      } catch (error) {
        this.active = null;
        releaseInstalledView(this.store, installed, false);
        throw error;
      }
      return installed.context;
    } finally {
      this.finish(input.signal);
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.invalidate();
    this.releaseActiveView(false);
  }

  private releaseActiveView(preserveOpening: boolean) {
    let active = this.active;
    if (!active) return;
    this.active = null;
    releaseInstalledView(this.store, active, preserveOpening);
  }

  private assertOpen() {
    if (this.closed) throw new Error("The workspace document view coordinator is closed.");
  }
}

function releaseInstalledView(
  store: WorkspaceAppStore,
  installed: InstalledWorkspaceDocumentView,
  preserveOpening: boolean,
) {
  let errors: unknown[] = [];
  try {
    installed.release();
  } catch (error) {
    errors.push(error);
  }
  try {
    installed.retire();
  } catch (error) {
    errors.push(error);
  }
  clearWorkspaceDocumentView(store, preserveOpening);

  if (errors.length == 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Workspace document view release failed.");
}
