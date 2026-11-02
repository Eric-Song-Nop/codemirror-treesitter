import type { OpendalBrowserError } from "@codemirror-treesitter/opendal-wasm-browser";
import { Predicate, Schema } from "effect";

/**
 * Typed workspace storage failures. Every class is a `Schema.TaggedError`, so
 * Effect code can recover with `Effect.catchTag`, while Promise callers still
 * receive a real `Error` with the same user-facing `message` (the UI and i18n
 * map those English messages to localized text).
 *
 * The `code`/`retryable` pair is kept on every storage error because it is part
 * of the Agent tool contract (`WorkspaceAgentIssue`) and of document-change
 * sampling keys.
 */
export type WorkspaceStorageErrorCode =
  | "already-exists"
  | "authentication-expired"
  | "condition-failed"
  | "permission-denied"
  | "rate-limited"
  | "temporary"
  | "unknown"
  | "unsupported";

const failureFields = {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
};

/** Folder access was revoked or needs to be granted again. */
export class WorkspacePermissionDenied extends Schema.TaggedError<WorkspacePermissionDenied>()(
  "WorkspacePermissionDenied",
  failureFields,
) {
  get code() {
    return "permission-denied" as const;
  }
  get retryable() {
    return false;
  }
}

/** A provider rejected the current credentials and they could not be renewed in place. */
export class WorkspaceAuthExpired extends Schema.TaggedError<WorkspaceAuthExpired>()(
  "WorkspaceAuthExpired",
  failureFields,
) {
  get code() {
    return "authentication-expired" as const;
  }
  get retryable() {
    return false;
  }
}

/** A conditional write lost a race: the target exists or its revision changed. */
export class WorkspaceConflict extends Schema.TaggedError<WorkspaceConflict>()(
  "WorkspaceConflict",
  {
    ...failureFields,
    code: Schema.Literals(["already-exists", "condition-failed"]),
  },
) {
  get retryable() {
    return false;
  }
}

/** A transient network or provider failure (including rate limiting). */
export class WorkspaceTransientFailure extends Schema.TaggedError<WorkspaceTransientFailure>()(
  "WorkspaceTransientFailure",
  {
    ...failureFields,
    code: Schema.Literals(["rate-limited", "temporary"]),
    retryable: Schema.Boolean,
  },
) {}

/** The storage backend cannot perform the requested operation. */
export class WorkspaceUnsupported extends Schema.TaggedError<WorkspaceUnsupported>()(
  "WorkspaceUnsupported",
  failureFields,
) {
  get code() {
    return "unsupported" as const;
  }
  get retryable() {
    return false;
  }
}

/** Any other storage failure. */
export class WorkspaceStorageFailure extends Schema.TaggedError<WorkspaceStorageFailure>()(
  "WorkspaceStorageFailure",
  { ...failureFields, retryable: Schema.Boolean },
) {
  get code() {
    return "unknown" as const;
  }
}

export type WorkspaceStorageError =
  | WorkspaceAuthExpired
  | WorkspaceConflict
  | WorkspacePermissionDenied
  | WorkspaceStorageFailure
  | WorkspaceTransientFailure
  | WorkspaceUnsupported;

/** A workspace path that the caller expected to exist is missing. */
export class WorkspaceNotFound extends Schema.TaggedError<WorkspaceNotFound>()(
  "WorkspaceNotFound",
  { message: Schema.String, path: Schema.String },
) {}

/** A port-level mutation (create, upload) did not end as applied/committed. */
export class WorkspaceMutationNotApplied extends Schema.TaggedError<WorkspaceMutationNotApplied>()(
  "WorkspaceMutationNotApplied",
  { message: Schema.String, path: Schema.String, status: Schema.String },
) {
  static readonly forStatus = (path: string, status: string) =>
    new WorkspaceMutationNotApplied({
      message: `Workspace mutation for ${path} ended with ${status}.`,
      path,
      status,
    });
}

/** A dropped or pasted file is not an image the workspace can store. */
export class WorkspaceUnsupportedImage extends Schema.TaggedError<WorkspaceUnsupportedImage>()(
  "WorkspaceUnsupportedImage",
  { message: Schema.String, name: Schema.String },
) {}

/** Storage work was requested after its workspace runtime closed. */
export class WorkspaceHostDisposed extends Schema.TaggedError<WorkspaceHostDisposed>()(
  "WorkspaceHostDisposed",
  { message: Schema.String },
) {
  static readonly make = () =>
    new WorkspaceHostDisposed({ message: "OpenDAL operator host is disposed." });
}

/**
 * Renewing provider credentials failed (for example the re-authorization popup
 * was blocked). `reason` keeps the provider's typed error; `message` repeats its
 * user-facing text.
 */
export class WorkspaceAuthRenewalFailed extends Schema.TaggedError<WorkspaceAuthRenewalFailed>()(
  "WorkspaceAuthRenewalFailed",
  { message: Schema.String, reason: Schema.Defect() },
) {
  static readonly fromCause = (reason: unknown) =>
    new WorkspaceAuthRenewalFailed({
      message: Predicate.isError(reason) ? reason.message : String(reason),
      reason,
    });
}

/** Everything a workspace object-store operation can fail with. */
export type WorkspaceStoreError =
  | WorkspaceAuthRenewalFailed
  | WorkspaceHostDisposed
  | WorkspaceStorageError;

const storageErrorTags: ReadonlySet<string> = new Set([
  "WorkspaceAuthExpired",
  "WorkspaceConflict",
  "WorkspacePermissionDenied",
  "WorkspaceStorageFailure",
  "WorkspaceTransientFailure",
  "WorkspaceUnsupported",
]);

export function isWorkspaceStorageError(value: unknown): value is WorkspaceStorageError {
  return (
    Predicate.hasProperty(value, "_tag") &&
    Predicate.isString(value._tag) &&
    storageErrorTags.has(value._tag)
  );
}

/** Builds the tagged storage error for a storage error code. */
export function workspaceStorageError(input: {
  cause?: unknown;
  code: WorkspaceStorageErrorCode;
  message: string;
  retryable?: boolean;
}): WorkspaceStorageError {
  let base =
    input.cause === undefined
      ? { message: input.message }
      : { cause: input.cause, message: input.message };
  switch (input.code) {
    case "permission-denied":
      return new WorkspacePermissionDenied(base);
    case "authentication-expired":
      return new WorkspaceAuthExpired(base);
    case "already-exists":
    case "condition-failed":
      return new WorkspaceConflict({ ...base, code: input.code });
    case "rate-limited":
    case "temporary":
      return new WorkspaceTransientFailure({
        ...base,
        code: input.code,
        retryable: input.retryable ?? true,
      });
    case "unsupported":
      return new WorkspaceUnsupported(base);
    case "unknown":
      return new WorkspaceStorageFailure({ ...base, retryable: input.retryable ?? false });
  }
}

const permissionDeniedErrorNames = new Set(["NotAllowedError", "SecurityError"]);

/**
 * True when an error (or any error in its cause chain) is a File System Access
 * permission failure: a DOM `NotAllowedError`/`SecurityError`, or a storage or
 * OpenDAL error already classified as `permission-denied`.
 */
export function isPermissionDeniedError(error: unknown): boolean {
  let seen = new Set<unknown>();
  let current = error;
  while (Predicate.isObject(current) && !seen.has(current)) {
    seen.add(current);
    let record = current as { cause?: unknown; code?: unknown; name?: unknown };
    if (record.code == "permission-denied") return true;
    if (Predicate.isString(record.name) && permissionDeniedErrorNames.has(record.name)) return true;
    current = record.cause;
  }
  return false;
}

export function storageErrorFromOpendal(error: OpendalBrowserError): WorkspaceStorageError {
  let code: WorkspaceStorageErrorCode =
    error.code == "not-found"
      ? "unknown"
      : error.code != "permission-denied" && isPermissionDeniedError(error.cause)
        ? "permission-denied"
        : error.code;
  return workspaceStorageError({
    cause: error,
    code,
    message: error.message,
    retryable: error.retryable,
  });
}
