import { useEffect, useRef } from "react";
import { errorToMessage } from "@/lib/workspace/errors";
import type { WorkspaceCollaborativeDocument } from "@/lib/workspace/documents";
import type { SourceAutoSaveTask } from "@/lib/workspace/types";

type MutableRef<T> = {
  current: T;
};

type DocumentPersistenceTarget = Pick<WorkspaceCollaborativeDocument, "flush">;

type UseWorkspacePersistenceLifecycleOptions = {
  autoSaveTaskRef: MutableRef<SourceAutoSaveTask | null>;
  clearDocumentView: () => Promise<unknown>;
  collabDocumentRef: MutableRef<DocumentPersistenceTarget | null>;
  dirtyRef: MutableRef<boolean>;
  setErrorMessage: (message: string) => void;
};

export function useWorkspacePersistenceLifecycle({
  autoSaveTaskRef,
  clearDocumentView,
  collabDocumentRef,
  dirtyRef,
  setErrorMessage,
}: UseWorkspacePersistenceLifecycleOptions) {
  let lifecycleGenerationRef = useRef(0);

  useEffect(() => {
    let lifecycleGeneration = ++lifecycleGenerationRef.current;
    let active = true;
    let flushInFlight: Promise<void> | null = null;

    let flushActivePersistence = (force = false) => {
      if (!force && flushInFlight) return flushInFlight;

      let document = collabDocumentRef.current;
      let sourceTask = autoSaveTaskRef.current?.task ?? null;
      let operation = flushPersistence(document, sourceTask);
      let trackedOperation = operation.finally(() => {
        if (flushInFlight === trackedOperation) flushInFlight = null;
      });
      flushInFlight = trackedOperation;
      return trackedOperation;
    };
    let reportFlushError = (error: unknown) => {
      if (active) setErrorMessage(errorToMessage(error));
    };
    let handlePageHide = () => {
      void flushActivePersistence().catch(reportFlushError);
    };
    let handleVisibilityChange = () => {
      if (document.visibilityState == "hidden") handlePageHide();
    };
    let handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      void flushActivePersistence(true).catch(reportFlushError);
      event.preventDefault();
      event.returnValue = true;
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      let sourceTask = autoSaveTaskRef.current?.task ?? null;

      void flushActivePersistence(true)
        .catch(() => {})
        .finally(async () => {
          if (lifecycleGenerationRef.current != lifecycleGeneration) return;
          sourceTask?.dispose();
          await clearDocumentView().catch(() => {});
        });
    };
  }, [autoSaveTaskRef, clearDocumentView, collabDocumentRef, dirtyRef, setErrorMessage]);
}

async function flushPersistence(
  document: DocumentPersistenceTarget | null,
  sourceTask: SourceAutoSaveTask["task"] | null,
) {
  // Start both writes before yielding. A pagehide handler gets no guarantee that
  // the browser will keep the page alive long enough for one write to await the
  // other, and the two persistence layers protect different recovery paths.
  let operations: Promise<void>[] = [];
  if (document) operations.push(document.flush());
  if (sourceTask) operations.push(sourceTask.flush());

  let results = await Promise.allSettled(operations);
  let errors = results
    .filter((result): result is PromiseRejectedResult => result.status == "rejected")
    .map((result) => result.reason as unknown);

  if (errors.length == 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Workspace persistence failed.");
}
