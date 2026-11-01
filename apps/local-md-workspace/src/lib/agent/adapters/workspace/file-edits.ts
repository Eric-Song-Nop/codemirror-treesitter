import {
  awaitWorkspaceAgentOperation,
  throwIfWorkspaceAgentAborted,
} from "../../application/abort.ts";
import { resolveWorkspaceMarkdownFile } from "../../application/workspace-catalog.ts";
import type { WorkspaceAgentRuntime } from "../../application/workspace-search.ts";
import type {
  WorkspaceAgentTextEdit,
  WorkspaceAgentWriteFileInput,
  WorkspaceAgentWriteFileResult,
} from "../../domain/contracts.ts";
import type { WorkspaceAgentLimits } from "../../domain/limits.ts";
import {
  applyWorkspaceAgentEdits,
  inverseWorkspaceAgentEdit,
  summarizeWorkspaceAgentChange,
} from "../../application/change-summary.ts";
import type {
  WorkspaceAgentRevertResult,
  WorkspaceAgentWriteControl,
} from "../../application/host-port.ts";

export async function writeWorkspaceAgentFile(input: {
  control?: WorkspaceAgentWriteControl;
  limits: Pick<WorkspaceAgentLimits, "catalog" | "write">;
  request: WorkspaceAgentWriteFileInput;
  runtime: WorkspaceAgentRuntime;
  signal?: AbortSignal;
}): Promise<WorkspaceAgentWriteFileResult> {
  let path = input.request.path;
  if (
    input.request.edits.length < 1 ||
    input.request.edits.length > input.limits.write.maxReplacements
  ) {
    return notApplied(
      path,
      "invalid-edit-count",
      `write_file accepts between 1 and ${input.limits.write.maxReplacements} edits.`,
    );
  }

  let resolved: Awaited<ReturnType<typeof resolveWorkspaceMarkdownFile>>;
  try {
    resolved = await resolveWorkspaceMarkdownFile({
      limits: input.limits.catalog,
      path,
      signal: input.signal,
      tree: input.runtime.tree,
    });
  } catch (error) {
    if (input.signal?.aborted) return aborted(path, input.signal.reason);
    throw error;
  }
  path = resolved.file?.path ?? path;
  if (resolved.issue) {
    return notApplied(path, "unavailable", resolved.issue.message);
  }
  if (!resolved.file) {
    let reason = resolved.reason ?? "outside-workspace";
    return notApplied(
      path,
      reason,
      reason == "not-markdown"
        ? "Only Markdown workspace files can be edited."
        : "The file is outside the current workspace or no longer exists.",
    );
  }

  let document;
  try {
    document = await awaitWorkspaceAgentOperation(
      input.runtime.documents.document(path),
      input.signal,
    );
    throwIfWorkspaceAgentAborted(input.signal);
  } catch (error) {
    if (input.signal?.aborted) return aborted(path, input.signal.reason);
    return notApplied(path, "unavailable", errorMessage(error));
  }

  // Pin the document for the whole transaction (approval wait, commit, flush)
  // so registry idle/LRU eviction cannot close it mid-edit.
  let release = document.retain?.() ?? (() => {});
  try {
    return await applyApprovedEdit({ ...input, document, path });
  } finally {
    release();
  }
}

async function applyApprovedEdit(input: {
  control?: WorkspaceAgentWriteControl;
  document: Awaited<ReturnType<WorkspaceAgentRuntime["documents"]["document"]>>;
  limits: Pick<WorkspaceAgentLimits, "catalog" | "write">;
  path: string;
  request: WorkspaceAgentWriteFileInput;
  runtime: WorkspaceAgentRuntime;
  signal?: AbortSignal;
}): Promise<WorkspaceAgentWriteFileResult> {
  let { document, path } = input;
  let current = document.read();
  let projected = projectEdits(current, input.request.edits);
  if (projected != null && utf8ByteLength(projected) > input.limits.write.maxOutputBytes) {
    return notApplied(
      path,
      "output-too-large",
      `The edited document would exceed ${input.limits.write.maxOutputBytes} bytes.`,
    );
  }

  let mismatch =
    projected == null
      ? -1
      : input.request.edits.findIndex(
          (edit) => current.slice(edit.from, edit.to) != edit.expectedText,
        );
  if (mismatch >= 0) {
    return {
      editIndex: mismatch,
      message: conflictMessage("expected-text-mismatch"),
      path,
      reason: "expected-text-mismatch",
      status: "not-applied",
    };
  }

  if (input.control?.approve && projected != null) {
    let approved: boolean;
    try {
      approved = await input.control.approve({
        change: summarizeWorkspaceAgentChange(current, projected),
        path,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) return aborted(path, input.signal.reason);
      return notApplied(path, "denied", errorMessage(error, "The user did not approve the edit."));
    }
    if (input.signal?.aborted) return aborted(path, input.signal.reason);
    if (!approved) {
      return notApplied(
        path,
        "denied",
        "The user denied this edit. Do not retry it unless the user asks again.",
      );
    }
  }

  let before = document.read();
  let result = document.edit(input.request.edits);
  if (result.status == "conflict") {
    return {
      editIndex: result.editIndex,
      message: conflictMessage(result.reason),
      path,
      reason: result.reason,
      status: "not-applied",
    };
  }
  let after = result.value;
  try {
    input.control?.onApplied?.({
      change: summarizeWorkspaceAgentChange(before, after),
      path,
      revert: () => revertWorkspaceAgentEdit(input.runtime, path, before, after),
    });
  } catch {
    // Observers must not turn an applied edit into a failure.
  }

  let persistence: Extract<WorkspaceAgentWriteFileResult, { status: "applied" }>["persistence"];
  // Cancellation cannot make an already-committed Loro edit become not-applied.
  try {
    await document.flush();
    persistence = { status: "saved" };
  } catch (error) {
    let status = document.snapshot().persistenceStatus;
    persistence = {
      message: errorMessage(error),
      status: status == "blocked" ? "blocked" : "error",
    };
  }

  return {
    appliedEdits: result.appliedEdits,
    generation: result.generation,
    outputBytes: utf8ByteLength(after),
    path,
    persistence,
    status: "applied",
  };
}

/**
 * Restores `before` by applying the inverse of an Agent edit to the shared
 * document resolved through the workspace registry (never a CodeMirror view
 * or a second Loro peer). Fails with "conflict" when the edited span changed.
 */
export async function revertWorkspaceAgentEdit(
  runtime: Pick<WorkspaceAgentRuntime, "documents">,
  path: string,
  before: string,
  after: string,
): Promise<WorkspaceAgentRevertResult> {
  let document;
  try {
    document = await runtime.documents.document(path);
  } catch (error) {
    return { message: errorMessage(error), status: "failed" };
  }
  let release = document.retain?.() ?? (() => {});
  try {
    let current = document.read();
    if (current == before) return { status: "reverted" };
    let inverse = inverseWorkspaceAgentEdit(before, after);
    let result = document.edit([inverse]);
    if (result.status == "conflict") {
      return {
        message: "The file changed after the Agent edit; revert it manually.",
        status: "conflict",
      };
    }
    try {
      await document.flush();
    } catch (error) {
      return { message: errorMessage(error), status: "failed" };
    }
    return { status: "reverted" };
  } catch (error) {
    return { message: errorMessage(error), status: "failed" };
  } finally {
    release();
  }
}

function projectEdits(value: string, edits: readonly WorkspaceAgentTextEdit[]) {
  let sorted = edits.toSorted((left, right) => left.from - right.from || left.to - right.to);
  for (let index = 0; index < sorted.length; index++) {
    let edit = sorted[index]!;
    if (
      !Number.isSafeInteger(edit.from) ||
      !Number.isSafeInteger(edit.to) ||
      edit.from < 0 ||
      edit.to < edit.from ||
      edit.to > value.length ||
      (index > 0 && edit.from < sorted[index - 1]!.to)
    ) {
      return null;
    }
  }

  return applyWorkspaceAgentEdits(value, sorted);
}

function conflictMessage(reason: "expected-text-mismatch" | "invalid-range" | "overlapping-edits") {
  switch (reason) {
    case "expected-text-mismatch":
      return "The expected text no longer matches. Read the file again before retrying.";
    case "invalid-range":
      return "An edit range is outside the current document.";
    case "overlapping-edits":
      return "Edits in one write_file call must not overlap.";
  }
}

function aborted(path: string, reason: unknown): WorkspaceAgentWriteFileResult {
  return notApplied(path, "aborted", errorMessage(reason, "The edit was aborted before applying."));
}

function notApplied(
  path: string,
  reason: Extract<WorkspaceAgentWriteFileResult, { status: "not-applied" }>["reason"],
  message: string,
): WorkspaceAgentWriteFileResult {
  return { message, path, reason, status: "not-applied" };
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function errorMessage(error: unknown, fallback = "The workspace document is unavailable.") {
  return error instanceof Error && error.message ? error.message : fallback;
}
