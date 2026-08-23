import type { WorkspaceRuntime } from "./types.ts";

export async function transitionWorkspaceRuntime(input: {
  activate: (runtime: WorkspaceRuntime) => void;
  closeActiveDocument: () => Promise<void>;
  current: WorkspaceRuntime | null;
  next: WorkspaceRuntime;
}) {
  try {
    await input.closeActiveDocument();
    input.activate(input.next);
  } catch (error) {
    if (input.current !== input.next) await input.next.dispose().catch(() => {});
    throw error;
  }

  if (input.current !== input.next) await input.current?.dispose();
}

export function enqueueRuntimeTransition(
  queue: { current: Promise<void> },
  transition: () => Promise<void>,
) {
  let task = queue.current.catch(() => {}).then(transition);
  queue.current = task.catch(() => {});
  return task;
}
