export function throwIfWorkspaceAgentAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

export async function awaitWorkspaceAgentOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    let onAbort = () =>
      reject(signal.reason ?? new DOMException("Operation aborted.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
