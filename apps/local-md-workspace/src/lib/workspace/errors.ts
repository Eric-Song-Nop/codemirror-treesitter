import { workspaceErrorMessage } from "@/lib/workspace-errors";

export function errorToMessage(error: unknown) {
  return workspaceErrorMessage(error);
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name == "AbortError";
}
