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
    "412 precondition failed",
    "409 conflict",
    "condition not match",
    "conditionnotmatch",
    "conflict",
    "file changed",
    "file lock",
    "locked",
    "no modification allowed",
    "precondition failed",
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
