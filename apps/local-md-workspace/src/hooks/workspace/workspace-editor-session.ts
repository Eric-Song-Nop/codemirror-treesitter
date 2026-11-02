import type { WorkspaceDocumentViewCoordinator } from "@/app/document-view-coordinator";
import type { Effect, Scope } from "effect";
import { runWorkspaceEffect } from "@/app/effect-bridge";
import type { WorkspaceAppServices, WorkspaceEffectRuntime } from "@/app/effect-runtime";
import {
  clearWorkspaceDocumentView,
  publishEditorDocumentValue,
  publishSingleFileDocumentView,
  publishWorkspaceDocumentSourceKind,
  publishWorkspaceRuntime,
  workspaceLiveObjects,
  type WorkspaceAppStore,
} from "@/app/workspace-store";
import {
  restoreOwnerShareRecordForPath,
  type OwnerShareRecord,
} from "@/lib/collaboration/share-storage";
import { sharedMarkdownDraftUnavailableMessage } from "@/lib/platform/share-target";
import { createDebouncedTask } from "@/lib/scheduling/debounced-task";
import {
  createWorkspaceDocumentContext,
  type WorkspaceDocumentContext,
} from "@/lib/workspace/document-context";
import type {
  CollaborativeDocumentSnapshot,
  WorkspaceCollaborativeDocument,
} from "@/lib/workspace/documents";
import { errorToMessage } from "@/lib/workspace/errors";
import type { AccessFileHandle } from "@/lib/workspace/file-system";
import type { DropboxRedirectDraft } from "@/lib/workspace/providers/dropbox/redirect-draft";
import {
  releaseWorkspaceRuntime,
  transitionWorkspaceRuntime,
} from "@/lib/workspace/runtime/runtime-lifecycle";
import type { WorkspaceRuntime } from "@/lib/workspace/runtime/types";
import { createSingleFileDraftSource, singleFileMarkdownNode } from "@/lib/workspace/single-file";
import {
  clearLastSingleFileDraft,
  createSingleFileDraft,
  deleteSingleFileDraft,
  loadLastSingleFileDraft,
  loadSingleFileDraft,
  rememberLastSingleFileDraft,
} from "@/lib/workspace/single-file-draft-store";
import { sourceAutoSaveKey, sourceAutoSaveTiming } from "@/lib/workspace/source-autosave";
import { workspaceSelectedPathContext } from "@/lib/workspace/state";
import { saveStoredWorkspaceSelectedPath } from "@/lib/workspace/store";
import { normalizeMarkdownPath, type MarkdownFileNode } from "@/lib/workspace/tree";
import {
  isWorkspaceFileSource,
  type ActiveOwnerShareRecord,
  type SaveState,
  type SelectedFileSource,
  type SingleFileSource,
  type SourceAutoSaveTask,
} from "@/lib/workspace/types";

/** A scoped effect that opens a workspace runtime on the application runtime. */
export type OpenWorkspaceRuntime<E = unknown> = Effect.Effect<
  WorkspaceRuntime,
  E,
  Scope.Scope | WorkspaceAppServices
>;

export type ReplaceWorkspaceRuntime = <E = never>(
  next: OpenWorkspaceRuntime<E> | WorkspaceRuntime,
  options?: { signal?: AbortSignal },
) => Promise<WorkspaceRuntime>;

/** Read-only view of a session field for hooks that still take ref-shaped inputs. */
export type SessionRef<T> = { readonly current: T };
/** Writable view of a session field. */
export type SessionCell<T> = { current: T };

export type StartOwnerShareHost = (
  record: OwnerShareRecord,
  context: WorkspaceDocumentContext,
  options?: { actionLabel?: string; shouldContinue?: () => boolean },
) => Promise<void>;

/** React-owned share state the session updates while switching documents. */
export type WorkspaceEditorSessionSharePorts = {
  setActiveShareRecord: (record: ActiveOwnerShareRecord | null) => void;
  setCreatedShare: (share: null) => void;
  startOwnerShareHost: StartOwnerShareHost;
};

export type OpenSingleFileDraftOptions = {
  draftId?: string;
  reuseLast?: boolean;
  saveCurrent?: boolean;
  shouldContinue?: () => boolean;
};

const detachedSharePorts: WorkspaceEditorSessionSharePorts = {
  setActiveShareRecord: () => {},
  setCreatedShare: () => {},
  startOwnerShareHost: async () => {},
};

/**
 * Non-React coordinator for the selected document: editor text tracking,
 * standalone auto-save, collaborative persistence status, document switching,
 * and workspace runtime replacement. One instance exists per workspace
 * application; React components subscribe to the Zustand store it publishes to
 * and call its methods. Live objects (runtime, documents, handles) stay here or
 * in {@link workspaceLiveObjects}, never in Zustand state.
 */
export class WorkspaceEditorSession {
  private autoSaveTask: SourceAutoSaveTask | null = null;
  private cleanValue = "";
  private collabDocument: WorkspaceCollaborativeDocument | null = null;
  private dirty = false;
  private editorValue = "";
  private imageUploadAbort: AbortController | null = null;
  private localFileHandle: AccessFileHandle | null = null;
  private permissionSubscription: (() => void) | null = null;
  private saveOperation = 0;
  private saveState: SaveState = "idle";
  private selectedFile: MarkdownFileNode | null = null;
  private selectedFileSource: SelectedFileSource | null = null;
  private sharePorts = detachedSharePorts;
  private singleFileSource: SingleFileSource | null = null;
  private standaloneSave: Promise<boolean> = Promise.resolve(true);

  /**
   * Ref-shaped views for hooks that have not moved onto the session yet. They
   * read session state; only the image-upload and save-operation cells write.
   */
  readonly refs: {
    autoSaveTaskRef: SessionRef<SourceAutoSaveTask | null>;
    collabDocumentRef: SessionRef<WorkspaceCollaborativeDocument | null>;
    dirtyRef: SessionRef<boolean>;
    editorValueRef: SessionRef<string>;
    imageUploadAbortRef: SessionCell<AbortController | null>;
    localFileHandleRef: SessionRef<AccessFileHandle | null>;
    saveOperationRef: SessionCell<number>;
    selectedFileRef: SessionRef<MarkdownFileNode | null>;
    selectedFileSourceRef: SessionRef<SelectedFileSource | null>;
    singleFileSourceRef: SessionRef<SingleFileSource | null>;
    workspaceRuntimeRef: SessionRef<WorkspaceRuntime | null>;
  };

  constructor(
    private readonly input: {
      documentViews: WorkspaceDocumentViewCoordinator;
      effectRuntime?: Pick<WorkspaceEffectRuntime, "runPromiseExit">;
      store: WorkspaceAppStore;
    },
  ) {
    this.refs = {
      autoSaveTaskRef: readRef(() => this.autoSaveTask),
      collabDocumentRef: readRef(() => this.collabDocument),
      dirtyRef: readRef(() => this.dirty),
      editorValueRef: readRef(() => this.editorValue),
      imageUploadAbortRef: writableRef(
        () => this.imageUploadAbort,
        (value) => {
          this.imageUploadAbort = value;
        },
      ),
      localFileHandleRef: readRef(() => this.localFileHandle),
      saveOperationRef: writableRef(
        () => this.saveOperation,
        (value) => {
          this.saveOperation = value;
        },
      ),
      selectedFileRef: readRef(() => this.selectedFile),
      selectedFileSourceRef: readRef(() => this.selectedFileSource),
      singleFileSourceRef: readRef(() => this.singleFileSource),
      workspaceRuntimeRef: readRef(() => this.workspaceRuntime),
    };
  }

  private get store() {
    return this.input.store;
  }

  private get documentViews() {
    return this.input.documentViews;
  }

  get workspaceRuntime() {
    return workspaceLiveObjects(this.store).workspaceRuntime;
  }

  /** Connects React-owned share state. Returns a disconnect function. */
  connectShareHost(ports: WorkspaceEditorSessionSharePorts) {
    this.sharePorts = ports;
    return () => {
      if (this.sharePorts === ports) this.sharePorts = detachedSharePorts;
    };
  }

  // ---------------------------------------------------------------------------
  // Store publication

  private setErrorMessage(message: string) {
    this.store.getState().setField("errorMessage", message);
  }

  private setRetryLoadPath(path: string | null) {
    this.store.getState().setField("retryLoadPath", path);
  }

  private setSaveState(next: SaveState) {
    if (this.saveState == next) return;
    this.saveState = next;
    this.store.getState().setField("saveState", next);
  }

  // ---------------------------------------------------------------------------
  // Image uploads

  cancelImageUpload = () => {
    this.imageUploadAbort?.abort();
    this.imageUploadAbort = null;
  };

  // ---------------------------------------------------------------------------
  // Saving

  clearPendingSaveTimer() {
    this.autoSaveTask?.task.cancel();
  }

  /** Flushes the collaborative document and the standalone auto-save task together. */
  persistenceTargets() {
    return { document: this.collabDocument, sourceTask: this.autoSaveTask?.task ?? null };
  }

  applyCollaborativeDocumentSnapshot = (
    document: WorkspaceCollaborativeDocument,
    snapshot: CollaborativeDocumentSnapshot = document.snapshot(),
  ) => {
    if (this.collabDocument !== document) return snapshot;

    this.editorValue = snapshot.value;
    this.dirty = snapshot.persistenceStatus != "saved";
    publishEditorDocumentValue(this.store, { path: snapshot.path, value: snapshot.value });
    publishWorkspaceDocumentSourceKind(this.store, document);

    let saveState = documentSaveState(snapshot.persistenceStatus);
    this.setSaveState(saveState);
    if (saveState == "saved") this.cleanValue = snapshot.value;
    return snapshot;
  };

  saveCurrentFile = async (): Promise<boolean> => {
    let file = this.selectedFile;
    let document = this.collabDocument;
    if (document && file?.path == document.path) {
      this.clearPendingSaveTimer();
      if (document.snapshot().persistenceStatus != "saved") this.setSaveState("saving");
      try {
        await document.flush();
        let snapshot = this.applyCollaborativeDocumentSnapshot(document);
        if (snapshot.persistenceStatus == "saved") {
          this.setErrorMessage("");
          this.setRetryLoadPath(null);
          return true;
        }
        return false;
      } catch (error) {
        let snapshot = this.applyCollaborativeDocumentSnapshot(document);
        this.setSaveState("error");
        this.setRetryLoadPath(snapshot.sourceKind == "unavailable" ? document.path : null);
        this.setErrorMessage(errorToMessage(error));
        return false;
      }
    }

    let source = this.selectedFileSource;
    if (!source || !file || isWorkspaceFileSource(source)) return true;
    let value = this.editorValue;
    if (!this.dirty && value == this.cleanValue) return true;

    this.clearPendingSaveTimer();
    let operation = ++this.saveOperation;
    let request = this.standaloneSave
      .catch(() => true)
      .then(async () => {
        if (operation != this.saveOperation) return true;
        this.setSaveState("saving");
        try {
          await source.writeFile(value);
          if (
            operation == this.saveOperation &&
            this.selectedFileSource === source &&
            this.selectedFile === file
          ) {
            this.cleanValue = value;
            if (this.editorValue == value) {
              this.dirty = false;
              this.setSaveState("saved");
            }
          }
          return true;
        } catch (error) {
          if (operation == this.saveOperation) {
            this.setSaveState("error");
            this.setRetryLoadPath(null);
            this.setErrorMessage(errorToMessage(error));
          }
          return false;
        }
      });
    this.standaloneSave = request;
    return request;
  };

  scheduleAutoSave = () => {
    let key = sourceAutoSaveKey(this.selectedFileSource);
    let autoSaveTask = this.autoSaveTask;
    if (!autoSaveTask || autoSaveTask.key != key) {
      autoSaveTask?.task.dispose();
      let timing = sourceAutoSaveTiming(key);
      autoSaveTask = {
        key,
        task: createDebouncedTask({
          delayMs: timing.delayMs,
          maxWaitMs: timing.maxWaitMs,
          run: async () => {
            await this.saveCurrentFile();
          },
        }),
      };
      this.autoSaveTask = autoSaveTask;
    }
    autoSaveTask.task.schedule();
  };

  handleEditorInput = (value: string) => {
    this.editorValue = value;

    let document = this.collabDocument;
    if (document) {
      let snapshot = document.snapshot();
      if (snapshot.value == value) {
        this.applyCollaborativeDocumentSnapshot(document, snapshot);
      } else {
        this.dirty = true;
        if (this.saveState != "pending") this.setSaveState("pending");
      }
      return;
    }

    this.dirty = true;
    if (this.saveState != "pending") this.setSaveState("pending");
    this.scheduleAutoSave();
  };

  // ---------------------------------------------------------------------------
  // Recovery

  keepCurrentDocumentAs = async (
    runtime: WorkspaceRuntime,
    file: MarkdownFileNode,
    document: WorkspaceCollaborativeDocument,
    rawPath: string,
  ) => {
    this.assertCurrentRecoveryDocument(runtime, file, document);
    let targetPath = normalizeMarkdownPath(rawPath);
    await document.writeCopy(targetPath);
    return targetPath;
  };

  resolveCurrentDocumentUseExternal = async (
    runtime: WorkspaceRuntime,
    file: MarkdownFileNode,
    document: WorkspaceCollaborativeDocument,
  ) => {
    this.assertCurrentRecoveryDocument(runtime, file, document);
    let source = document.collabState.source;
    if (source.kind != "recovery-required") {
      throw new Error("The document no longer requires external-source recovery.");
    }
    let result = await document.useExternalChange(source.incoming.revision);
    if (result.status == "incoming-changed") {
      throw new Error("The external source changed again. Review it before confirming.");
    }
    this.applyCollaborativeDocumentSnapshot(document);
    this.setErrorMessage("");
    this.setRetryLoadPath(null);
  };

  recreateCurrentDocumentSource = async (
    runtime: WorkspaceRuntime,
    file: MarkdownFileNode,
    document: WorkspaceCollaborativeDocument,
  ) => {
    this.assertCurrentRecoveryDocument(runtime, file, document);
    await document.recreateSource();
    this.applyCollaborativeDocumentSnapshot(document);
    this.setErrorMessage("");
    this.setRetryLoadPath(null);
  };

  private assertCurrentRecoveryDocument(
    runtime: WorkspaceRuntime,
    file: MarkdownFileNode,
    document: WorkspaceCollaborativeDocument,
  ) {
    if (
      this.selectedFileSource !== runtime ||
      this.selectedFile?.path != file.path ||
      this.collabDocument !== document
    ) {
      throw new Error("The selected document changed before recovery completed.");
    }
  }

  // ---------------------------------------------------------------------------
  // Folder access

  /**
   * Prompts to re-grant folder access (call from a user gesture) and resumes
   * the selected document's pending saves once access is granted.
   */
  regrantWorkspaceAccess = async () => {
    let runtime = this.workspaceRuntime;
    let permission = runtime?.host.permission;
    if (!runtime || !permission) return false;
    let state: PermissionState;
    try {
      state = await permission.request();
    } catch (error) {
      this.setErrorMessage(errorToMessage(error));
      return false;
    }
    this.store.getState().setField("workspacePermission", state);
    if (state != "granted" || this.workspaceRuntime !== runtime) return false;

    let document = this.collabDocument;
    if (document && this.selectedFileSource === runtime) {
      if (this.saveState == "error" || document.snapshot().persistenceStatus != "saved") {
        this.setSaveState("saving");
        try {
          // Re-materialize: a failed generation is not retried by flush().
          await document.importExternalChange();
        } catch (error) {
          this.applyCollaborativeDocumentSnapshot(document);
          this.setErrorMessage(errorToMessage(error));
          return false;
        }
        this.applyCollaborativeDocumentSnapshot(document);
      }
    }
    this.setErrorMessage("");
    this.setRetryLoadPath(null);
    return true;
  };

  private watchPermission(runtime: WorkspaceRuntime | null) {
    this.permissionSubscription?.();
    this.permissionSubscription = null;
    let permission = runtime?.host.permission;
    if (!permission) return;
    this.permissionSubscription = permission.subscribe((state) => {
      if (this.workspaceRuntime !== runtime) return;
      this.store.getState().setField("workspacePermission", state);
    });
  }

  // ---------------------------------------------------------------------------
  // Workspace runtime lifecycle

  /**
   * Activates a workspace runtime: either an already built runtime or a scoped
   * effect that opens one (see `LocalWorkspaceStorage`, `DropboxWorkspaces`).
   * The runtime is acquired in its own scope; if opening fails, is interrupted
   * (`signal`), or activation fails, everything it acquired is released, and the
   * replaced runtime is released after the new one is active.
   */
  replaceWorkspaceRuntime: ReplaceWorkspaceRuntime = (next, options = {}) => {
    let effectRuntime = this.input.effectRuntime;
    if (!effectRuntime) throw new Error("The editor session has no workspace effect runtime.");
    // `signal` cancels opening; once the runtime is active the transition finishes.
    let activated = false;
    let cancel = new AbortController();
    let onAbort = () => {
      if (!activated) cancel.abort();
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    return runWorkspaceEffect(
      effectRuntime,
      transitionWorkspaceRuntime({
        activate: (runtime) => {
          activated = true;
          publishWorkspaceRuntime(this.store, runtime);
          this.watchPermission(runtime);
        },
        clearDocumentView: this.clearDocumentView,
        current: () => this.workspaceRuntime,
        next,
      }),
      { signal: cancel.signal },
    ).finally(() => options.signal?.removeEventListener("abort", onAbort));
  };

  /** Releases the active runtime; used when the workspace root unmounts. */
  disposeWorkspaceRuntime() {
    let release = {
      current: () => this.workspaceRuntime,
      deactivate: () => {
        this.watchPermission(null);
        workspaceLiveObjects(this.store).workspaceRuntime = null;
      },
    };
    let effectRuntime = this.input.effectRuntime;
    if (!effectRuntime) {
      let runtime = release.current();
      release.deactivate();
      void runtime?.dispose().catch(() => {});
      return;
    }
    void runWorkspaceEffect(effectRuntime, releaseWorkspaceRuntime(release)).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Document selection

  private invalidateStandaloneSave() {
    this.saveOperation += 1;
  }

  private invalidateDocumentTarget() {
    this.cancelImageUpload();
    this.documentViews.invalidate();
  }

  private resetEditorView = () => {
    this.clearPendingSaveTimer();
    this.invalidateStandaloneSave();
    this.collabDocument = null;
    this.selectedFile = null;
    this.selectedFileSource = null;
    this.singleFileSource = null;
    this.localFileHandle = null;
    this.editorValue = "";
    this.cleanValue = "";
    this.dirty = false;
    this.saveState = "idle";
    this.sharePorts.setActiveShareRecord(null);
    this.sharePorts.setCreatedShare(null);
  };

  clearDocumentView = async () => {
    this.cancelImageUpload();
    let outcome = await this.documentViews.close();
    if (!outcome || outcome.hadActiveView) return;
    this.resetEditorView();
    clearWorkspaceDocumentView(this.store);
  };

  beginDocumentViewChange = (path = "") => {
    this.cancelImageUpload();
    return this.documentViews.begin(path, { currentValue: this.editorValue });
  };

  finishDocumentViewChange = (signal: AbortSignal) => this.documentViews.finish(signal);

  activateSingleFileDocument = async (
    singleFile: SingleFileSource,
    persistence: SelectedFileSource,
    file: MarkdownFileNode,
    value: string,
    options: {
      signal: AbortSignal;
      localFileHandle?: AccessFileHandle;
    },
  ) => {
    let outcome = await this.documentViews.close(options.signal);
    if (!outcome || !this.documentViews.isCurrent(options.signal)) return false;
    if (!outcome.hadActiveView) this.resetEditorView();
    this.selectedFileSource = persistence;
    this.selectedFile = file;
    this.singleFileSource = singleFile;
    this.editorValue = value;
    this.cleanValue = value;
    this.dirty = false;
    this.localFileHandle =
      singleFile.kind == "local-file" ? (options.localFileHandle ?? null) : null;

    this.saveState = "saved";
    publishSingleFileDocumentView(this.store, {
      file,
      singleFileSource: singleFile,
      value,
    });
    this.setErrorMessage("");
    this.setRetryLoadPath(null);
    return true;
  };

  discardMaterializedDraft = (source: SingleFileSource | null) => {
    if (source?.kind != "draft") return;
    void deleteSingleFileDraft(source.draftId).catch(() => {});
    void clearLastSingleFileDraft(source.draftId).catch(() => {});
  };

  openSingleFileDraft = async (options: OpenSingleFileDraftOptions = {}) => {
    if (options.shouldContinue && !options.shouldContinue()) return;
    let signal = this.beginDocumentViewChange("Untitled.md");

    this.setErrorMessage("");
    this.setRetryLoadPath(null);
    try {
      if ((options.saveCurrent ?? true) && !(await this.saveCurrentFile())) return;
      if (!this.documentViews.isCurrent(signal)) return;
      if (options.shouldContinue && !options.shouldContinue()) return;

      let draft = options.draftId
        ? await loadSingleFileDraft(options.draftId).catch(() => null)
        : options.reuseLast === true
          ? await loadLastSingleFileDraft().catch(() => null)
          : null;
      if (!draft && options.draftId) throw new Error(sharedMarkdownDraftUnavailableMessage);
      draft ??= await createSingleFileDraft({ name: "Untitled.md" });
      await rememberLastSingleFileDraft(draft.id).catch(() => {});
      if (!this.documentViews.isCurrent(signal)) return;
      if (options.shouldContinue && !options.shouldContinue()) return;

      let source = createSingleFileDraftSource(draft);
      await this.activateSingleFileDocument(
        { draftId: draft.id, kind: "draft", name: draft.name },
        source,
        singleFileMarkdownNode(draft.name),
        draft.value,
        { signal },
      );
    } catch (error) {
      if (this.documentViews.isCurrent(signal)) this.setErrorMessage(errorToMessage(error));
    } finally {
      this.documentViews.finish(signal);
    }
  };

  loadFile = async (
    runtime: WorkspaceRuntime,
    file: MarkdownFileNode,
    options: { signal?: AbortSignal; saveCurrent?: boolean } = {},
  ) => {
    let signal = options.signal ?? this.beginDocumentViewChange(file.path);

    this.setErrorMessage("");
    this.setRetryLoadPath(null);

    try {
      let outcome = await this.documentViews.select({
        signal,
        prepare: async () => {
          // Workspace documents materialize independently of UI selection. Only
          // a standalone draft needs an explicit save before the view changes.
          if (
            (options.saveCurrent ?? true) &&
            !this.collabDocument &&
            !(await this.saveCurrentFile())
          ) {
            return null;
          }
          if (!this.documentViews.isCurrent(signal)) return null;

          let restoredShareRecord = await restoreOwnerShareRecordForPath(
            runtime.identity,
            file.path,
          ).catch(() => null);
          if (!this.documentViews.isCurrent(signal)) return null;

          let document = await runtime.documents.document(file.path);
          let snapshot = document.snapshot();
          let nextSaveState = documentSaveState(snapshot.persistenceStatus);

          return {
            activate: () => {
              this.resetEditorView();
              try {
                this.selectedFile = file;
                this.selectedFileSource = runtime;
                this.collabDocument = document;
                this.editorValue = snapshot.value;
                this.cleanValue = snapshot.value;
                this.dirty = snapshot.persistenceStatus != "saved";
                this.singleFileSource = null;
                this.localFileHandle = null;
                this.saveState = nextSaveState;

                let stopSubscription = document.subscribe((event) => {
                  if (this.collabDocument !== document) return;
                  this.applyCollaborativeDocumentSnapshot(document, event.snapshot);
                  if (event.kind == "persistence-error") {
                    this.setErrorMessage(errorToMessage(event.error));
                    this.setRetryLoadPath(
                      event.snapshot.sourceKind == "unavailable" ? document.path : null,
                    );
                  } else if (event.kind == "materialized") {
                    this.setErrorMessage("");
                    this.setRetryLoadPath(null);
                  }
                });

                let selectedPathContext = workspaceSelectedPathContext(runtime.identity);
                if (selectedPathContext) {
                  saveStoredWorkspaceSelectedPath(selectedPathContext, file.path);
                }

                let context = createWorkspaceDocumentContext(runtime, file, document);
                this.sharePorts.setActiveShareRecord(restoredShareRecord);
                if (restoredShareRecord) {
                  void this.sharePorts.startOwnerShareHost(restoredShareRecord, context);
                }
                this.setRetryLoadPath(null);

                return {
                  context,
                  release: stopSubscription,
                  retire: this.resetEditorView,
                };
              } catch (error) {
                this.resetEditorView();
                throw error;
              }
            },
            view: { document, file, saveState: nextSaveState, value: snapshot.value },
          };
        },
      });
      return outcome != null;
    } catch (error) {
      if (!this.documentViews.isCurrent(signal)) return false;
      this.setErrorMessage(errorToMessage(error));
      this.setRetryLoadPath(file.path);
      return false;
    }
  };

  restoreCloudRedirectEditorDraft = (runtime: WorkspaceRuntime, draft: DropboxRedirectDraft) => {
    if (!draft.selectedPath || draft.dirtyValue == null) return false;

    let file = this.selectedFile;
    if (!file || file.path != draft.selectedPath) return false;
    let document = this.collabDocument;
    if (!document || document.path != file.path) return false;

    this.invalidateDocumentTarget();
    this.selectedFileSource = runtime;
    let currentValue = document.read();
    let result = document.edit([
      { expectedText: currentValue, from: 0, insert: draft.dirtyValue, to: currentValue.length },
    ]);
    if (result.status == "conflict") return false;
    this.applyCollaborativeDocumentSnapshot(document);
    return true;
  };

  ensureSelectedCollabDocument = async (runtime: WorkspaceRuntime, file: MarkdownFileNode) =>
    runtime.documents.document(file.path);
}

function writableRef<T>(read: () => T, write: (value: T) => void): SessionCell<T> {
  return {
    get current() {
      return read();
    },
    set current(value) {
      write(value);
    },
  };
}

function readRef<T>(read: () => T): SessionRef<T> {
  return {
    get current() {
      return read();
    },
  };
}

function documentSaveState(status: CollaborativeDocumentSnapshot["persistenceStatus"]): SaveState {
  switch (status) {
    case "pending":
      return "pending";
    case "saving":
      return "saving";
    case "saved":
      return "saved";
    case "blocked":
    case "error":
      return "error";
  }
}
