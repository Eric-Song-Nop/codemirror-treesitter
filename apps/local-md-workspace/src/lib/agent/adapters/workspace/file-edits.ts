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

export async function writeWorkspaceAgentFile(input: {
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

  let projected = projectEdits(document.read(), input.request.edits);
  if (projected != null && utf8ByteLength(projected) > input.limits.write.maxOutputBytes) {
    return notApplied(
      path,
      "output-too-large",
      `The edited document would exceed ${input.limits.write.maxOutputBytes} bytes.`,
    );
  }

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
    outputBytes: utf8ByteLength(result.value),
    path,
    persistence,
    status: "applied",
  };
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

  let output = value;
  for (let edit of sorted.toReversed()) {
    output = `${output.slice(0, edit.from)}${edit.insert}${output.slice(edit.to)}`;
  }
  return output;
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
