import type { ChangeSpec } from "@codemirror/state";
import {
  captureWorkspaceAgentActiveEditor,
  workspaceAgentActiveEditorConflicts,
  type WorkspaceAgentActiveEditorCapability,
} from "./active-editor.ts";
import type {
  WorkspaceAgentApplyCurrentDocumentEditsInput,
  WorkspaceAgentApplyCurrentDocumentEditsResult,
  WorkspaceAgentEditFailureReason,
  WorkspaceAgentLegacyTextEdit,
} from "../../domain/contracts.ts";
import type { WorkspaceAgentLimits } from "../../domain/limits.ts";

type ResolvedWorkspaceAgentTextEdit = {
  change: ChangeSpec;
  editIndex: number;
  from: number;
  to: number;
};

type ResolveWorkspaceAgentTextEditsResult =
  | {
      changes: ChangeSpec[];
      outputBytes: number;
      status: "resolved";
    }
  | {
      editIndex?: number;
      message: string;
      reason: Extract<
        WorkspaceAgentEditFailureReason,
        | "ambiguous-old-text"
        | "invalid-edit-count"
        | "missing-old-text"
        | "output-too-large"
        | "overlapping-edits"
      >;
      status: "not-resolved";
    };

function resolveWorkspaceAgentTextEdits(input: {
  baseValue: string;
  edits: readonly WorkspaceAgentLegacyTextEdit[];
  maxOutputBytes: number;
  maxReplacements: number;
}): ResolveWorkspaceAgentTextEditsResult {
  if (input.edits.length < 1 || input.edits.length > input.maxReplacements) {
    return {
      message: `Provide between 1 and ${input.maxReplacements} replacements.`,
      reason: "invalid-edit-count",
      status: "not-resolved",
    };
  }

  let resolved: ResolvedWorkspaceAgentTextEdit[] = [];
  for (let editIndex = 0; editIndex < input.edits.length; editIndex++) {
    let edit = input.edits[editIndex]!;
    if (!edit.oldText) {
      if (!input.baseValue && input.edits.length == 1) {
        resolved.push({ change: { from: 0, insert: edit.newText }, editIndex, from: 0, to: 0 });
        continue;
      }
      return {
        editIndex,
        message: "An empty oldText is only valid for a single insertion into an empty document.",
        reason: "ambiguous-old-text",
        status: "not-resolved",
      };
    }

    let from = input.baseValue.indexOf(edit.oldText);
    if (from < 0) {
      return {
        editIndex,
        message: `Replacement ${editIndex + 1} did not match the current document.`,
        reason: "missing-old-text",
        status: "not-resolved",
      };
    }
    if (input.baseValue.indexOf(edit.oldText, from + 1) >= 0) {
      return {
        editIndex,
        message: `Replacement ${editIndex + 1} matched more than one range.`,
        reason: "ambiguous-old-text",
        status: "not-resolved",
      };
    }
    let to = from + edit.oldText.length;
    resolved.push({
      change: { from, insert: edit.newText, to },
      editIndex,
      from,
      to,
    });
  }

  resolved.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let index = 1; index < resolved.length; index++) {
    let previous = resolved[index - 1]!;
    let current = resolved[index]!;
    if (current.from < previous.to) {
      return {
        editIndex: current.editIndex,
        message: `Replacement ${current.editIndex + 1} overlaps another replacement.`,
        reason: "overlapping-edits",
        status: "not-resolved",
      };
    }
  }

  let outputBytes = input.edits.reduce(
    (total, edit) => total - utf8ByteLength(edit.oldText) + utf8ByteLength(edit.newText),
    utf8ByteLength(input.baseValue),
  );
  if (outputBytes > input.maxOutputBytes) {
    return {
      message: `The edited document exceeds the ${input.maxOutputBytes}-byte limit.`,
      reason: "output-too-large",
      status: "not-resolved",
    };
  }

  return {
    changes: resolved.map((edit) => edit.change),
    outputBytes,
    status: "resolved",
  };
}

export function applyWorkspaceAgentCurrentDocumentEdits(input: {
  activeEditor: WorkspaceAgentActiveEditorCapability | undefined;
  limits: WorkspaceAgentLimits["write"];
  request: WorkspaceAgentApplyCurrentDocumentEditsInput;
  signal?: AbortSignal;
  workspaceId: string;
}): WorkspaceAgentApplyCurrentDocumentEditsResult {
  let path = input.request.version.path;
  if (input.signal?.aborted) return notApplied(path, "aborted", "The Agent run was stopped.");

  let initial = captureWorkspaceAgentActiveEditor(input.activeEditor);
  if (!initial) {
    return notApplied(
      path,
      "active-document-unavailable",
      "The bound workspace document is no longer active.",
    );
  }
  let initialConflicts = workspaceAgentActiveEditorConflicts({
    capture: initial,
    expected: input.request.version,
  });
  addWorkspaceHostConflict(initialConflicts, input, initial.document.workspaceId);
  if (initialConflicts.length) return stale(path, initialConflicts);

  let resolved = resolveWorkspaceAgentTextEdits({
    baseValue: initial.document.value,
    edits: input.request.edits,
    maxOutputBytes: input.limits.maxOutputBytes,
    maxReplacements: input.limits.maxReplacements,
  });
  if (resolved.status == "not-resolved") {
    return {
      editIndex: resolved.editIndex,
      message: resolved.message,
      path,
      reason: resolved.reason,
      status: "not-applied",
    };
  }

  // This second capture and all checks below intentionally share one synchronous
  // call stack with dispatch. No storage, CRDT, or network operation belongs here.
  let current = captureWorkspaceAgentActiveEditor(input.activeEditor);
  if (!current) {
    return notApplied(
      path,
      "active-document-unavailable",
      "The bound workspace document is no longer active.",
    );
  }
  let conflicts = workspaceAgentActiveEditorConflicts({
    capture: current,
    expected: input.request.version,
  });
  addWorkspaceHostConflict(conflicts, input, current.document.workspaceId);
  if (current.view !== initial.view && !conflicts.includes("documentGeneration")) {
    conflicts.push("documentGeneration");
  }
  if (conflicts.length) return stale(path, conflicts);
  if (input.signal?.aborted) return notApplied(path, "aborted", "The Agent run was stopped.");

  current.view.dispatch({
    changes: resolved.changes,
    userEvent: "input.agent",
  });
  return {
    appliedEdits: input.request.edits.length,
    outputBytes: resolved.outputBytes,
    path,
    status: "applied",
  };
}

function stale(
  path: string,
  conflicts: NonNullable<
    Extract<WorkspaceAgentApplyCurrentDocumentEditsResult, { status: "not-applied" }>["conflicts"]
  >,
): WorkspaceAgentApplyCurrentDocumentEditsResult {
  return {
    conflicts,
    message: "The active document changed after it was read. Read it again before editing.",
    path,
    reason: "stale-version",
    status: "not-applied",
  };
}

function addWorkspaceHostConflict(
  conflicts: NonNullable<
    Extract<WorkspaceAgentApplyCurrentDocumentEditsResult, { status: "not-applied" }>["conflicts"]
  >,
  input: {
    request: WorkspaceAgentApplyCurrentDocumentEditsInput;
    workspaceId: string;
  },
  activeWorkspaceId: string,
) {
  if (
    (input.request.version.workspaceId != input.workspaceId ||
      activeWorkspaceId != input.workspaceId) &&
    !conflicts.includes("workspaceId")
  ) {
    conflicts.push("workspaceId");
  }
}

function notApplied(
  path: string,
  reason: WorkspaceAgentEditFailureReason,
  message: string,
): WorkspaceAgentApplyCurrentDocumentEditsResult {
  return { message, path, reason, status: "not-applied" };
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}
