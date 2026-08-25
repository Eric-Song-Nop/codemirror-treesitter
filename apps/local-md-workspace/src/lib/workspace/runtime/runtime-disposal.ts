import type { WorkspaceDocuments } from "../documents/contracts.ts";

export function createWorkspaceRuntimeDisposal(input: {
  changes: { dispose(): void } | null;
  documents: WorkspaceDocuments;
  host: { dispose(): Promise<void> };
}) {
  let request: Promise<void> | null = null;
  return () => (request ??= disposeWorkspaceRuntime(input));
}

async function disposeWorkspaceRuntime(input: {
  changes: { dispose(): void } | null;
  documents: WorkspaceDocuments;
  host: { dispose(): Promise<void> };
}) {
  let errors: unknown[] = [];
  try {
    await input.documents.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    input.changes?.dispose();
  } catch (error) {
    errors.push(error);
  }
  try {
    await input.host.dispose();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length == 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Workspace runtime failed to close.");
}
