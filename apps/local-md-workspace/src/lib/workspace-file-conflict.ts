import { hashMarkdownText } from "./markdown-hash.ts";
import type { WorkspaceBackend } from "./workspace-backend.ts";

export type WorkspaceFileConflict = {
  baseHash: string;
  externalHash: string;
  externalValue: string;
  kind: "external-change" | "write-conflict";
  localHash: string;
  path: string;
};

export async function detectWorkspaceFileConflict(
  backend: WorkspaceBackend,
  path: string,
  baseHash: string,
  localValue: string,
) {
  let externalValue = await backend.readFile(path);
  return createWorkspaceFileConflict("external-change", path, baseHash, localValue, externalValue);
}

export async function readWorkspaceFileWriteConflict(
  backend: WorkspaceBackend,
  path: string,
  baseHash: string,
  localValue: string,
  error: unknown,
) {
  if (!isWorkspaceWriteConflictError(error)) return null;

  let externalValue = await backend.readFile(path);
  return createWorkspaceFileConflict("write-conflict", path, baseHash, localValue, externalValue);
}

export function createWorkspaceFileConflict(
  kind: WorkspaceFileConflict["kind"],
  path: string,
  baseHash: string,
  localValue: string,
  externalValue: string,
): WorkspaceFileConflict | null {
  let externalHash = hashMarkdownText(externalValue);
  if (externalHash == baseHash || externalValue == localValue) return null;

  return {
    baseHash,
    externalHash,
    externalValue,
    kind,
    localHash: hashMarkdownText(localValue),
    path,
  };
}

export function isWorkspaceWriteConflictError(error: unknown) {
  let name = error instanceof DOMException ? error.name : "";
  if (name == "NoModificationAllowedError") return true;

  let normalized = normalizeErrorText(error instanceof Error ? error.message : String(error));
  if (
    matchesAny(normalized, [
      "lookup not found",
      "lookup/not found",
      "lookup not_found",
      "not found",
      "not_found",
      "path not found",
      "path/not found",
      "path not_found",
    ])
  ) {
    return false;
  }

  return matchesAny(normalized, [
    "409 conflict",
    "conflict",
    "file changed",
    "file lock",
    "locked",
    "no modification allowed",
    "rev mismatch",
    "too many write operations",
    "too_many_write_operations",
    "write conflict",
  ]);
}

function matchesAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

function normalizeErrorText(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/[\\/]+/g, "/");
}
