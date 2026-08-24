import { useEffect, useRef } from "react";
import { errorToMessage } from "@/lib/workspace/errors";
import type { SourceAutoSaveTask } from "@/lib/workspace/types";

type MutableRef<T> = {
  current: T;
};

type UseWorkspacePersistenceLifecycleOptions<Document> = {
  autoSaveTaskRef: MutableRef<SourceAutoSaveTask | null>;
  closeActiveDocument: () => Promise<unknown>;
  collabDocumentRef: MutableRef<Document | null>;
  dirtyRef: MutableRef<boolean>;
  flushCollabDocument: (document: Document) => Promise<void>;
  setErrorMessage: (message: string) => void;
};

export function useWorkspacePersistenceLifecycle<Document>({
  autoSaveTaskRef,
  closeActiveDocument,
  collabDocumentRef,
  dirtyRef,
  flushCollabDocument,
  setErrorMessage,
}: UseWorkspacePersistenceLifecycleOptions<Document>) {
  let lifecycleGenerationRef = useRef(0);

  useEffect(() => {
    let lifecycleGeneration = ++lifecycleGenerationRef.current;
    let active = true;
    let flushInFlight: Promise<void> | null = null;

    let flushActivePersistence = (force = false) => {
      if (!force && flushInFlight) return flushInFlight;

      let document = collabDocumentRef.current;
      let sourceTask = autoSaveTaskRef.current?.task ?? null;
      let operation = flushPersistence(document, sourceTask, flushCollabDocument);
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
          await closeActiveDocument().catch(() => {});
        });
    };
  }, [
    autoSaveTaskRef,
    closeActiveDocument,
    collabDocumentRef,
    dirtyRef,
    flushCollabDocument,
    setErrorMessage,
  ]);
}

async function flushPersistence<Document>(
  document: Document | null,
  sourceTask: SourceAutoSaveTask["task"] | null,
  flushCollabDocument: (document: Document) => Promise<void>,
) {
  // Start both writes before yielding. A pagehide handler gets no guarantee that
  // the browser will keep the page alive long enough for one write to await the
  // other, and the two persistence layers protect different recovery paths.
  let operations: Promise<void>[] = [];
  if (document) operations.push(flushCollabDocument(document));
  if (sourceTask) operations.push(sourceTask.flush());

  let results = await Promise.allSettled(operations);
  let errors = results
    .filter((result): result is PromiseRejectedResult => result.status == "rejected")
    .map((result) => result.reason as unknown);

  if (errors.length == 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Workspace persistence failed.");
}
