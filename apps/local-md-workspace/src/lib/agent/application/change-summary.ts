import type { WorkspaceAgentChangeSummary, WorkspaceAgentTextEdit } from "../domain/contracts.ts";

export const WORKSPACE_AGENT_DIFF_MAX_LINES = 40;
const lcsCellBudget = 250_000;
const diffLineMaxCharacters = 240;

/**
 * Summarizes a text change as added/removed line counts plus a short
 * unified-style diff. Display-only: it is shown to the user, not the model.
 */
export function summarizeWorkspaceAgentChange(
  before: string,
  after: string,
  maxLines = WORKSPACE_AGENT_DIFF_MAX_LINES,
): WorkspaceAgentChangeSummary {
  let left = before.split("\n");
  let right = after.split("\n");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] == right[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] == right[right.length - 1 - suffix]
  ) {
    suffix++;
  }

  let removedLines = left.slice(prefix, left.length - suffix);
  let addedLines = right.slice(prefix, right.length - suffix);
  let operations = diffLines(removedLines, addedLines);
  let added = operations.filter((operation) => operation.kind == "+").length;
  let removed = operations.filter((operation) => operation.kind == "-").length;
  if (!added && !removed) return { added: 0, diff: "", removed: 0, truncated: false };

  let lines = [
    `@@ -${prefix + 1},${removedLines.length} +${prefix + 1},${addedLines.length} @@`,
    ...operations.map((operation) => `${operation.kind}${clip(operation.text)}`),
  ];
  let truncated = lines.length > maxLines;
  if (truncated) lines = [...lines.slice(0, maxLines - 1), "…"];
  return { added, diff: lines.join("\n"), removed, truncated };
}

/** Applies offset edits to a string, assuming they were validated already. */
export function applyWorkspaceAgentEdits(value: string, edits: readonly WorkspaceAgentTextEdit[]) {
  let output = value;
  for (let edit of edits.toSorted((a, b) => a.from - b.from || a.to - b.to).toReversed()) {
    output = `${output.slice(0, edit.from)}${edit.insert}${output.slice(edit.to)}`;
  }
  return output;
}

/**
 * The single exact edit that turns `after` back into `before`, guarded by the
 * changed span so a revert never clobbers text edited since.
 */
export function inverseWorkspaceAgentEdit(before: string, after: string): WorkspaceAgentTextEdit {
  let prefix = 0;
  let limit = Math.min(before.length, after.length);
  while (prefix < limit && before[prefix] == after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    before[before.length - 1 - suffix] == after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    expectedText: after.slice(prefix, after.length - suffix),
    from: prefix,
    insert: before.slice(prefix, before.length - suffix),
    to: after.length - suffix,
  };
}

type DiffOperation = { kind: " " | "+" | "-"; text: string };

function diffLines(left: readonly string[], right: readonly string[]): DiffOperation[] {
  if (!left.length) return right.map((text) => ({ kind: "+", text }));
  if (!right.length) return left.map((text) => ({ kind: "-", text }));
  if (left.length * right.length > lcsCellBudget) {
    return [
      ...left.map((text) => ({ kind: "-" as const, text })),
      ...right.map((text) => ({ kind: "+" as const, text })),
    ];
  }

  let width = right.length + 1;
  let table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] =
        left[i] == right[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }

  let operations: DiffOperation[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] == right[j]) {
      operations.push({ kind: " ", text: left[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      operations.push({ kind: "-", text: left[i++]! });
    } else {
      operations.push({ kind: "+", text: right[j++]! });
    }
  }
  while (i < left.length) operations.push({ kind: "-", text: left[i++]! });
  while (j < right.length) operations.push({ kind: "+", text: right[j++]! });
  return operations;
}

function clip(text: string) {
  return text.length > diffLineMaxCharacters ? `${text.slice(0, diffLineMaxCharacters)}…` : text;
}
